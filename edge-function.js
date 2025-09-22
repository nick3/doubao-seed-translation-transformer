// 腾讯 EdgeOne 边缘函数 - doubao-seed-translation 模型适配器

// === 配置常量 ===
const CONFIG = {
    DOUBAO_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3/responses",
    DEFAULT_TARGET_LANGUAGE: "zh",
    MAX_REQUEST_SIZE: 24 * 1024,
};

// === 预编译常量 ===
const HEADERS_JSON = { 'Content-Type': 'application/json' };
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// 预编译错误响应模板
const ERROR_TEMPLATES = {
    https: '{"error":{"message":"需要 HTTPS","type":"security_error"}}',
    notFound: '{"error":{"message":"Not Found","type":"invalid_request_error"}}',
    noAuth: '{"error":{"message":"缺少 API 密钥","type":"invalid_request_error","code":"invalid_api_key"}}',
    tooLarge: '{"error":{"message":"请求过大","type":"invalid_request_error"}}',
    noMessage: '{"error":{"message":"无用户消息","type":"invalid_request_error"}}',
    noModel: '{"error":{"message":"缺少 model","type":"invalid_request_error"}}',
    invalidJson: '{"error":{"message":"无效 JSON","type":"invalid_request_error"}}',
    serverError: '{"error":{"message":"内部服务错误","type":"api_error"}}',
    upstreamError: (msg) => `{"error":{"message":"上游 API 错误：${msg}","type":"api_error"}}`
};

// === 内联工具函数 ===
const genId = (prefix = 'chatcmpl') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const isHttps = (request, url) => url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
const errorRes = (template, status = 400, msg = '') => new Response(
    typeof template === 'function' ? template(msg) : ERROR_TEMPLATES[template],
    { status, headers: HEADERS_JSON }
);

/**
 * 从系统消息中解析翻译语言选项
 * @param {string|undefined} systemPrompt - 系统消息内容
 * @returns {{source_language?: string, target_language: string}}
 */
function parseTranslationOptions(systemPrompt) {
    const options = { target_language: CONFIG.DEFAULT_TARGET_LANGUAGE };
    if (!systemPrompt) return options;

    try {
        // 优先尝试解析为 JSON
        const jsonOptions = JSON.parse(systemPrompt);
        if (jsonOptions.source_language) options.source_language = jsonOptions.source_language;
        if (jsonOptions.target_language) options.target_language = jsonOptions.target_language;
        return options;
    } catch (e) {
        // 如果不是 JSON，尝试用正则表达式解析 key:value 格式
        const sourceLangMatch = systemPrompt.match(/source_language\s*:\s*['"]?(\w+)['"]?/);
        const targetLangMatch = systemPrompt.match(/target_language\s*:\s*['"]?(\w+)['"]?/);
        if (sourceLangMatch?.[1]) options.source_language = sourceLangMatch[1];
        if (targetLangMatch?.[1]) options.target_language = targetLangMatch[1];
    }
    return options;
}

/**
 * 将火山引擎的响应转换为 OpenAI 格式
 * @param {object} doubaoResponse - 火山引擎 API 的响应体
 * @param {string} requestModelId - 用户请求中指定的模型 ID
 * @returns {Response} - OpenAI 格式的 Response 对象
 */
function convertToOpenAIResponse(doubaoResponse, requestModelId) {
    if (doubaoResponse.error) {
        const errorMessage = doubaoResponse.error.message || JSON.stringify(doubaoResponse.error);
        return errorRes(ERROR_TEMPLATES.upstreamError, 500, errorMessage);
    }

    const messageContent = doubaoResponse.output
        ?.find(o => o.type === 'message' && o.role === 'assistant')
        ?.content?.find(c => c.type === 'output_text')
        ?.text;

    if (!messageContent) {
        return errorRes(ERROR_TEMPLATES.upstreamError, 500, "未找到有效的翻译结果");
    }

    const openaiResponse = {
        id: genId('chatcmpl'),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestModelId,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: messageContent,
            },
            finish_reason: "stop"
        }],
        usage: {
            prompt_tokens: doubaoResponse.usage?.input_tokens || 0,
            completion_tokens: doubaoResponse.usage?.output_tokens || 0,
            total_tokens: doubaoResponse.usage?.total_tokens || 0,
        }
    };

    return new Response(JSON.stringify(openaiResponse), { headers: HEADERS_JSON });
}


// === 主处理函数 ===
async function handleRequest(request) {
    const url = new URL(request.url);

    if (!isHttps(request, url)) return errorRes('https', 400);
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return errorRes('notFound', 404);

    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return errorRes('noAuth', 401);

    try {
        if (parseInt(request.headers.get('content-length') || '0') > CONFIG.MAX_REQUEST_SIZE) {
            return errorRes('tooLarge');
        }

        const data = await request.json();

        const userMsgContent = data.messages?.findLast?.(m => m?.role === "user")?.content;
        if (!userMsgContent) return errorRes('noMessage');

        const modelId = data.model;
        if (!modelId) return errorRes('noModel');

        const systemPrompt = data.messages?.find?.(m => m?.role === "system")?.content;
        const translationOptions = parseTranslationOptions(systemPrompt);

        const doubaoPayload = {
            model: modelId,
            input: [{
                role: "user",
                content: [{
                    type: "input_text",
                    text: typeof userMsgContent === 'string' ? userMsgContent : JSON.stringify(userMsgContent),
                    translation_options: translationOptions
                }]
            }]
        };

        const upstreamResponse = await fetch(CONFIG.DOUBAO_BASE_URL, {
            method: 'POST',
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(doubaoPayload)
        });

        const doubaoResult = await upstreamResponse.json();

        if (!upstreamResponse.ok) {
            const errorMsg = doubaoResult.error?.message || upstreamResponse.statusText;
            return errorRes(ERROR_TEMPLATES.upstreamError, upstreamResponse.status, errorMsg);
        }

        return convertToOpenAIResponse(doubaoResult, modelId);

    } catch (e) {
        if (e instanceof SyntaxError) return errorRes('invalidJson');
        console.error("Fetch handler error:", e);
        return errorRes('serverError', 500);
    }
}

// === EdgeOne 事件监听器 ===
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});