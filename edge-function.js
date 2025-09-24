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
        if (jsonOptions.source_language) {
            const convertedSource = getLanguageCode(jsonOptions.source_language);
            if (convertedSource) options.source_language = convertedSource;
        }
        if (jsonOptions.target_language) {
            const convertedTarget = getLanguageCode(jsonOptions.target_language);
            if (convertedTarget) options.target_language = convertedTarget;
        }
        return options;
    } catch (e) {
        // 如果不是 JSON，尝试用正则表达式解析 key:value 格式
        const sourceLangMatch = systemPrompt.match(/source_language\s*:\s*['"]?([^'"]+)['"]?/);
        const targetLangMatch = systemPrompt.match(/target_language\s*:\s*['"]?([^'"]+)['"]?/);
        if (sourceLangMatch?.[1]) {
            const convertedSource = getLanguageCode(sourceLangMatch[1]);
            if (convertedSource) options.source_language = convertedSource;
        }
        if (targetLangMatch?.[1]) {
            const convertedTarget = getLanguageCode(targetLangMatch[1]);
            if (convertedTarget) options.target_language = convertedTarget;
        }
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

        const isStream = typeof data.stream === 'boolean'
            ? data.stream
            : typeof data.stream === 'string'
                ? data.stream.toLowerCase() === 'true'
                : false;

        const doubaoPayload = {
            model: modelId,
            input: [{
                role: "user",
                content: [{
                    type: "input_text",
                    text: typeof userMsgContent === 'string' ? userMsgContent : JSON.stringify(userMsgContent),
                    translation_options: translationOptions
                }]
            }],
            ...(isStream ? { stream: true } : {})
        };

        const upstreamResponse = await fetch(CONFIG.DOUBAO_BASE_URL, {
            method: 'POST',
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(doubaoPayload)
        });

        if (!upstreamResponse.ok) {
            let errorMsg = upstreamResponse.statusText;
            try {
                const errorJson = await upstreamResponse.clone().json();
                errorMsg = errorJson.error?.message || errorMsg;
            } catch (err) {
                try {
                    errorMsg = await upstreamResponse.clone().text();
                } catch (_) {
                    /* no-op */
                }
            }
            return errorRes(ERROR_TEMPLATES.upstreamError, upstreamResponse.status, errorMsg);
        }

        if (isStream) {
            return streamDoubaoResponse(upstreamResponse, modelId);
        }

        const doubaoResult = await upstreamResponse.json();

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

function streamDoubaoResponse(upstreamResponse, modelId) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const streamId = genId('chatcmpl');
    let createdAt = Math.floor(Date.now() / 1000);
    let sentRoleChunk = false;
    let closed = false;
    let buffer = '';

    const enqueue = (controller, payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };

    const enqueueDone = (controller) => {
        if (closed) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        closed = true;
    };

    const usageFromDoubao = usage => usage ? {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0
    } : undefined;

    const stream = new ReadableStream({
        start(controller) {
            const reader = upstreamResponse.body.getReader();

            const handleEvent = (eventName, dataStr) => {
                if (!dataStr) return;
                if (dataStr === '[DONE]') {
                    enqueueDone(controller);
                    return;
                }

                let eventData;
                try {
                    eventData = JSON.parse(dataStr);
                } catch (err) {
                    console.error('Failed to parse SSE chunk', err, dataStr);
                    return;
                }

                if (eventName === 'response.created' && eventData.response?.created_at) {
                    createdAt = eventData.response.created_at;
                    return;
                }

                if (eventName === 'response.output_text.delta') {
                    const deltaText = eventData.delta;
                    if (!deltaText) return;
                    if (!sentRoleChunk) {
                        enqueue(controller, {
                            id: streamId,
                            object: 'chat.completion.chunk',
                            created: createdAt,
                            model: modelId,
                            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
                        });
                        sentRoleChunk = true;
                    }
                    enqueue(controller, {
                        id: streamId,
                        object: 'chat.completion.chunk',
                        created: createdAt,
                        model: modelId,
                        choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
                    });
                    return;
                }

                if (eventName === 'response.completed') {
                    const usage = usageFromDoubao(eventData.response?.usage);
                    const payload = {
                        id: streamId,
                        object: 'chat.completion.chunk',
                        created: createdAt,
                        model: modelId,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                    };
                    if (usage) payload.usage = usage;
                    enqueue(controller, payload);
                    enqueueDone(controller);
                    return;
                }

                // Ignore other metadata events
            };

            const processBuffer = () => {
                let delimiterIndex;
                while ((delimiterIndex = buffer.indexOf('\n\n')) !== -1) {
                    const rawEvent = buffer.slice(0, delimiterIndex).replace(/\r/g, '');
                    buffer = buffer.slice(delimiterIndex + 2);
                    if (!rawEvent.trim()) continue;
                    const lines = rawEvent.split('\n');
                    let eventName = '';
                    const dataLines = [];
                    for (const line of lines) {
                        if (line.startsWith('event:')) {
                            eventName = line.slice(6).trim();
                        } else if (line.startsWith('data:')) {
                            dataLines.push(line.slice(5).trim());
                        }
                    }
                    handleEvent(eventName, dataLines.join('\n'));
                }
            };

            const pump = () => reader.read()
                .then(({ done, value }) => {
                    if (done) {
                        const remainder = decoder.decode();
                        if (remainder) {
                            buffer += remainder;
                            processBuffer();
                        }
                        enqueueDone(controller);
                        return;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    processBuffer();
                    pump();
                })
                .catch(err => {
                    controller.error(err);
                    try { reader.cancel(err); } catch (_) { /* ignore */ }
                });

            pump();
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    });
}

// === 语言处理 ===
const languages = [
    { code: 'zh', names: ['中文（简体）', 'chinese (simplified)', '简体中文', 'chinese', 'zh'] },
    { code: 'zh-Hant', names: ['中文（繁体）', 'chinese (traditional)', '繁體中文', 'zh-hant'] },
    { code: 'en', names: ['英语', 'english', 'en'] },
    { code: 'ja', names: ['日语', 'japanese', '日本語', 'ja'] },
    { code: 'ko', names: ['韩语', 'korean', '한국어', 'ko'] },
    { code: 'de', names: ['德语', 'german', 'deutsch', 'de'] },
    { code: 'fr', names: ['法语', 'french', 'français', 'fr'] },
    { code: 'es', names: ['西班牙语', 'spanish', 'español', 'es'] },
    { code: 'it', names: ['意大利语', 'italian', 'italiano', 'it'] },
    { code: 'pt', names: ['葡萄牙语', 'portuguese', 'português', 'pt'] },
    { code: 'ru', names: ['俄语', 'russian', 'русский', 'ru'] },
    { code: 'th', names: ['泰语', 'thai', 'ไทย', 'th'] },
    { code: 'vi', names: ['越南语', 'vietnamese', 'tiếng việt', 'vi'] },
    { code: 'ar', names: ['阿拉伯语', 'arabic', 'العربية', 'ar'] },
    { code: 'cs', names: ['捷克语', 'czech', 'čeština', 'cs'] },
    { code: 'da', names: ['丹麦语', 'danish', 'dansk', 'da'] },
    { code: 'fi', names: ['芬兰语', 'finnish', 'suomi', 'fi'] },
    { code: 'hr', names: ['克罗地亚语', 'croatian', 'hrvatski', 'hr'] },
    { code: 'hu', names: ['匈牙利语', 'hungarian', 'magyar', 'hu'] },
    { code: 'id', names: ['印尼语', 'indonesian', 'bahasa indonesia', 'id'] },
    { code: 'ms', names: ['马来语', 'malay', 'bahasa melayu', 'ms'] },
    { code: 'nb', names: ['挪威布克莫尔语', 'norwegian bokmål', 'norsk bokmål', 'nb'] },
    { code: 'nl', names: ['荷兰语', 'dutch', 'nederlands', 'nl'] },
    { code: 'pl', names: ['波兰语', 'polish', 'polski', 'pl'] },
    { code: 'ro', names: ['罗马尼亚语', 'romanian', 'română', 'ro'] },
    { code: 'sv', names: ['瑞典语', 'swedish', 'svenska', 'sv'] },
    { code: 'tr', names: ['土耳其语', 'turkish', 'türkçe', 'tr'] },
    { code: 'uk', names: ['乌克兰语', 'ukrainian', 'українська', 'uk'] },
];

function getLanguageCode(lang) {
    if (!lang) {
        return undefined;
    }
    const normalizedLang = lang.toLowerCase().trim();
    for (const language of languages) {
        if (language.names.includes(normalizedLang)) {
            return language.code;
        }
    }
    return lang; // Return original value if no match found
}
