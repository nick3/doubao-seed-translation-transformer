// Cloudflare Worker - doubao-seed-translation 模型适配器
// 从腾讯 EdgeOne 边缘函数版本迁移

// === 配置常量 ===
const CONFIG = {
    DOUBAO_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3/responses",
    DEFAULT_TARGET_LANGUAGE: "zh",
    MAX_REQUEST_SIZE: 24 * 1024, // 24KB
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

function parseStreamFlag(streamValue) {
    if (typeof streamValue === "boolean") return streamValue;
    if (typeof streamValue === "string") return streamValue.toLowerCase() === "true";
    return false;
}

function extractTextFromContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        for (const part of content) {
            const text = extractTextFromContent(part);
            if (text) return text;
        }
        return "";
    }
    if (content && typeof content === "object") {
        if (typeof content.text === "string") return content.text;
        if (typeof content.content === "string") return content.content;
        if (Array.isArray(content.content)) return extractTextFromContent(content.content);
    }
    return "";
}

function parseResponsesInput(input) {
    let systemPrompt;
    let userContent;

    const handleSegment = (segment) => {
        if (!segment || typeof segment !== "object") return;
        const role = segment.role;
        const rawContent = segment.content ?? segment.input ?? segment.text ?? segment.value;
        const text = extractTextFromContent(rawContent);
        if (role === "system" && text) {
            systemPrompt = text;
            return;
        }
        if ((!role || role === "user") && text) {
            userContent = text;
        }
    };

    if (typeof input === "string") {
        userContent = input;
    } else if (Array.isArray(input)) {
        for (const segment of input) {
            if (typeof segment === "string") {
                if (!userContent) userContent = segment;
                continue;
            }
            handleSegment(segment);
        }
    } else if (input && typeof input === "object") {
        handleSegment(input);
    }

    return { systemPrompt, userContent };
}

function buildDoubaoPayload(modelId, translationOptions, userContent, isStream) {
    return {
        model: modelId,
        input: [{
            role: "user",
            content: [{
                type: "input_text",
                text: typeof userContent === 'string' ? userContent : JSON.stringify(userContent),
                translation_options: translationOptions
            }]
        }],
        ...(isStream ? { stream: true } : {})
    };
}

function mergeTranslationOverrides(targetOptions, ...sources) {
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const candidate = typeof source.translation_options === 'object'
            ? source.translation_options
            : source;
        if (candidate.source_language) {
            const convertedSource = getLanguageCode(candidate.source_language);
            if (convertedSource) targetOptions.source_language = convertedSource;
        }
        if (candidate.target_language) {
            const convertedTarget = getLanguageCode(candidate.target_language);
            if (convertedTarget) targetOptions.target_language = convertedTarget;
        }
    }
}

/**
 * 从豆包响应中提取助手消息内容
 * @param {object} doubaoResponse - 火山引擎 API 的响应体
 * @returns {string|undefined} - 提取的消息内容
 */
function extractAssistantMessage(doubaoResponse) {
    return doubaoResponse.output
        ?.find(o => o.type === 'message' && o.role === 'assistant')
        ?.content?.find(c => c.type === 'output_text')
        ?.text;
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

    const messageContent = extractAssistantMessage(doubaoResponse);

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

function convertToResponsesResponse(doubaoResponse, requestModelId) {
    if (doubaoResponse.error) {
        const errorMessage = doubaoResponse.error.message || JSON.stringify(doubaoResponse.error);
        return errorRes(ERROR_TEMPLATES.upstreamError, 500, errorMessage);
    }

    const responsePayload = { ...doubaoResponse };
    responsePayload.id = responsePayload.id || genId('resp');
    responsePayload.object = responsePayload.object || 'response';
    responsePayload.created = responsePayload.created || Math.floor(Date.now() / 1000);
    responsePayload.model = responsePayload.model || requestModelId;
    responsePayload.usage = {
        prompt_tokens: doubaoResponse.usage?.prompt_tokens ?? doubaoResponse.usage?.input_tokens ?? 0,
        completion_tokens: doubaoResponse.usage?.completion_tokens ?? doubaoResponse.usage?.output_tokens ?? 0,
        total_tokens: doubaoResponse.usage?.total_tokens
            ?? ((doubaoResponse.usage?.input_tokens || 0) + (doubaoResponse.usage?.output_tokens || 0))
    };

    if (!Array.isArray(responsePayload.output)) {
        const messageContent = extractAssistantMessage(doubaoResponse);
        responsePayload.output = messageContent
            ? [{
                id: genId('msg'),
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: messageContent }]
            }]
            : [];
    }

    return new Response(JSON.stringify(responsePayload), { headers: HEADERS_JSON });
}

async function sendDoubaoRequest(payload, auth) {
    const upstreamResponse = await fetch(CONFIG.DOUBAO_BASE_URL, {
        method: 'POST',
        headers: {
            'Authorization': auth,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!upstreamResponse.ok) {
        let errorMsg = upstreamResponse.statusText;
        try {
            const errorJson = await upstreamResponse.clone().json();
            errorMsg = errorJson.error?.message || errorMsg;
        } catch (_) {
            try {
                errorMsg = await upstreamResponse.clone().text();
            } catch (__) {
                /* no-op */
            }
        }
        return { error: errorRes(ERROR_TEMPLATES.upstreamError, upstreamResponse.status, errorMsg) };
    }

    return { upstreamResponse };
}

async function handleChatCompletionsRequest({ data, auth }) {
    const userMsgContent = extractTextFromContent(data.messages?.findLast?.(m => m?.role === "user")?.content);
    if (!userMsgContent) return errorRes('noMessage');

    const modelId = data.model;
    if (!modelId) return errorRes('noModel');

    const systemPrompt = data.messages?.find?.(m => m?.role === "system")?.content;
    const translationOptions = parseTranslationOptions(systemPrompt);
    mergeTranslationOverrides(translationOptions, data.translation_options, data.metadata);
    const isStream = parseStreamFlag(data.stream);

    const payload = buildDoubaoPayload(modelId, translationOptions, userMsgContent, isStream);
    const { error, upstreamResponse } = await sendDoubaoRequest(payload, auth);
    if (error) return error;

    if (isStream) {
        return streamDoubaoResponse(upstreamResponse, modelId);
    }

    const doubaoResult = await upstreamResponse.json();
    return convertToOpenAIResponse(doubaoResult, modelId);
}

async function handleResponsesRequest({ data, auth }) {
    const modelId = data.model;
    if (!modelId) return errorRes('noModel');

    const { systemPrompt, userContent } = parseResponsesInput(data.input);
    if (!userContent) return errorRes('noMessage');

    const translationOptions = parseTranslationOptions(systemPrompt);
    mergeTranslationOverrides(translationOptions, data.translation_options, data.metadata);
    const isStream = parseStreamFlag(data.stream);

    const payload = buildDoubaoPayload(modelId, translationOptions, userContent, isStream);
    const { error, upstreamResponse } = await sendDoubaoRequest(payload, auth);
    if (error) return error;

    if (isStream) {
        return streamResponses(upstreamResponse);
    }

    const doubaoResult = await upstreamResponse.json();
    return convertToResponsesResponse(doubaoResult, modelId);
}

function streamResponses(upstreamResponse) {
    const headers = {
        'Content-Type': upstreamResponse.headers?.get('Content-Type') || 'text/event-stream',
        'Cache-Control': upstreamResponse.headers?.get('Cache-Control') || 'no-cache',
        Connection: upstreamResponse.headers?.get('Connection') || 'keep-alive'
    };
    return new Response(upstreamResponse.body, {
        status: 200,
        headers
    });
}

function streamDoubaoResponse(upstreamResponse, modelId) {
    const streamId = genId('chatcmpl');
    let createdAt = Math.floor(Date.now() / 1000);
    let sentRoleChunk = false;
    let closed = false;
    let buffer = '';
    let bufferedNewlines = '';

    const enqueue = (controller, payload) => {
        controller.enqueue(ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };

    const enqueueDone = (controller) => {
        if (closed) return;
        controller.enqueue(ENCODER.encode('data: [DONE]\n\n'));
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
                    let deltaText = eventData.delta;
                    if (!deltaText) return;
                    deltaText = deltaText.replace(/\r/g, '');
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

                    if (!/[^\n]/.test(deltaText)) {
                        bufferedNewlines += deltaText;
                        return;
                    }

                    const leadingMatch = deltaText.match(/^\n+/);
                    const trailingMatch = deltaText.match(/\n+$/);
                    const leadingNewlines = leadingMatch ? leadingMatch[0] : '';
                    const trailingNewlines = trailingMatch ? trailingMatch[0] : '';
                    const contentStart = leadingNewlines.length;
                    const contentEnd = trailingNewlines ? deltaText.length - trailingNewlines.length : deltaText.length;
                    const coreContent = deltaText.slice(contentStart, contentEnd);

                    let emitText = '';
                    if (bufferedNewlines) {
                        emitText += bufferedNewlines;
                        bufferedNewlines = '';
                    }
                    if (leadingNewlines) {
                        emitText += leadingNewlines;
                    }
                    if (coreContent) {
                        emitText += coreContent;
                    }

                    if (emitText) {
                        enqueue(controller, {
                            id: streamId,
                            object: 'chat.completion.chunk',
                            created: createdAt,
                            model: modelId,
                            choices: [{ index: 0, delta: { content: emitText }, finish_reason: null }]
                        });
                    }

                    bufferedNewlines = trailingNewlines;
                    return;
                }

                if (eventName === 'response.completed') {
                    const usage = usageFromDoubao(eventData.response?.usage);
                    bufferedNewlines = '';
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
                        const remainder = DECODER.decode();
                        if (remainder) {
                            buffer += remainder;
                            processBuffer();
                        }
                        enqueueDone(controller);
                        return;
                    }
                    buffer += DECODER.decode(value, { stream: true });
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
    { code: 'zh', names: ['中文（简体）', 'simplified chinese', 'simplified chinese language', '简体中文', 'chinese', 'zh'] },
    { code: 'zh-Hant', names: ['中文（繁体）', 'traditional chinese', 'traditional chinese (taiwan) language', 'traditional chinese (hong kong) language', '繁體中文', 'zh-hant'] },
    { code: 'en', names: ['英语', 'english', 'english language', 'en'] },
    { code: 'ja', names: ['日语', 'japanese', 'japanese language', '日本語', 'ja'] },
    { code: 'ko', names: ['韩语', 'korean', 'korean language', '한국어', 'ko'] },
    { code: 'de', names: ['德语', 'german', 'german language', 'deutsch', 'de'] },
    { code: 'fr', names: ['法语', 'french', 'french language', 'français', 'fr'] },
    { code: 'es', names: ['西班牙语', 'spanish', 'spanish language', 'español', 'es'] },
    { code: 'it', names: ['意大利语', 'italian', 'italian language', 'italiano', 'it'] },
    { code: 'pt', names: ['葡萄牙语', 'portuguese', 'portuguese language', 'português', 'pt'] },
    { code: 'ru', names: ['俄语', 'russian', 'russian language', 'русский', 'ru'] },
    { code: 'th', names: ['泰语', 'thai', 'thai language', 'ไทย', 'th'] },
    { code: 'vi', names: ['越南语', 'vietnamese', 'vietnamese language', 'tiếng việt', 'vi'] },
    { code: 'ar', names: ['阿拉伯语', 'arabic', 'arabic language', 'العربية', 'ar'] },
    { code: 'cs', names: ['捷克语', 'czech', 'czech language', 'čeština', 'cs'] },
    { code: 'da', names: ['丹麦语', 'danish', 'danish language', 'dansk', 'da'] },
    { code: 'fi', names: ['芬兰语', 'finnish', 'finnish language', 'suomi', 'fi'] },
    { code: 'hr', names: ['克罗地亚语', 'croatian', 'croatian language', 'hrvatski', 'hr'] },
    { code: 'hu', names: ['匈牙利语', 'hungarian', 'hungarian language', 'magyar', 'hu'] },
    { code: 'id', names: ['印尼语', 'indonesian', 'indonesian language', 'bahasa indonesia', 'id'] },
    { code: 'ms', names: ['马来语', 'malay', 'malay language', 'bahasa melayu', 'ms'] },
    { code: 'nb', names: ['挪威布克莫尔语', 'norwegian bokmål', 'norsk bokmål', 'nb'] },
    { code: 'nl', names: ['荷兰语', 'dutch', 'dutch language', 'nederlands', 'nl'] },
    { code: 'pl', names: ['波兰语', 'polish', 'polish language', 'polski', 'pl'] },
    { code: 'ro', names: ['罗马尼亚语', 'romanian', 'romanian language', 'română', 'ro'] },
    { code: 'sv', names: ['瑞典语', 'swedish', 'swedish language', 'svenska', 'sv'] },
    { code: 'tr', names: ['土耳其语', 'turkish', 'turkish language', 'türkçe', 'tr'] },
    { code: 'uk', names: ['乌克兰语', 'ukrainian', 'ukrainian language', 'українська', 'uk'] },
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


// === Cloudflare Worker 主入口 ===
export default {
    /**
     * @param {Request} request
     * @param {object} env
     * @param {object} ctx
     * @returns {Promise<Response>}
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 在 Cloudflare 环境中，所有外部请求默认都是 HTTPS，此检查主要用于防御 x-forwarded-proto 伪造
        if (!isHttps(request, url)) return errorRes('https', 400);
        if (request.method !== 'POST') return errorRes('notFound', 404);

        const path = url.pathname;
        if (path !== '/v1/chat/completions' && path !== '/v1/responses') {
            return errorRes('notFound', 404);
        }

        const auth = request.headers.get('Authorization');
        if (!auth?.startsWith('Bearer ')) return errorRes('noAuth', 401);

        try {
            if (parseInt(request.headers.get('content-length') || '0') > CONFIG.MAX_REQUEST_SIZE) {
                return errorRes('tooLarge');
            }

            const data = await request.json();

            if (path === '/v1/chat/completions') {
                return handleChatCompletionsRequest({ data, auth });
            }

            return handleResponsesRequest({ data, auth });

        } catch (e) {
            if (e instanceof SyntaxError) return errorRes('invalidJson');
            console.error("Fetch handler error:", e);
            return errorRes('serverError', 500);
        }
    }
};
