# 使用指南（中文）

本文档提供从零到一的端到端示例，涵盖：
- 使用 curl 和 Node.js fetch 调用 /v1/chat/completions 与 /v1/responses
- SSE 客户端示例与消息拼接（OpenAI 风格与原生 event: 事件流）
- 常见错误复现与排查（认证、请求大小）
- 环境变量与 Docker 本地启动示例

与 README 中的说明一致，接口完全兼容 OpenAI Chat Completions 形式，建议先准备好一个可用的上游鉴权令牌，并部署到 EdgeOne 或在本地启动 Go 自托管版本后进行测试。

---

## 1. 预设环境变量

为方便演示，先在终端中导出两个变量：

```bash
# 边缘函数或本地服务的基地址（必须为 https；本地 Docker 例外，见后文）
export API_BASE="https://<your-edgeone-domain>"

# 上游火山引擎 Ark/Doubao 的 Bearer token（不要硬编码）
export TOKEN="<your-volcengine-ark-token>"
```

---

## 2. 使用 curl 端到端调用

### 2.1 /v1/chat/completions（非流式）

```bash
curl -X POST "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"doubao-seed-translation",
    "messages":[
      {"role":"system","content":"{\"target_language\":\"ja\"}"},
      {"role":"user","content":"Hello"}
    ],
    "stream": false
  }'
```

返回示例（简化）：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1727000000,
  "model": "doubao-seed-translation",
  "choices": [
    {"index":0,"message":{"role":"assistant","content":"こんにちは"},"finish_reason":"stop"}
  ],
  "usage": {"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
}
```

### 2.2 /v1/chat/completions（SSE 流式）

```bash
curl -N -X POST "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"doubao-seed-translation",
    "messages":[
      {"role":"system","content":"{\"target_language\":\"ja\"}"},
      {"role":"user","content":"Hello\nHow are you?"}
    ],
    "stream": true
  }'
```

输出为标准 SSE 流，形如：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"doubao-seed-translation","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"doubao-seed-translation","choices":[{"index":0,"delta":{"content":"こん"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"doubao-seed-translation","choices":[{"index":0,"delta":{"content":"にちは"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"doubao-seed-translation","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":...,"completion_tokens":...,"total_tokens":...}}

data: [DONE]
```

将每个块中 `choices[0].delta.content` 依次拼接，即得到完整回复文本。

### 2.3 /v1/responses（非流式）

`/v1/responses` 兼容 OpenAI Responses 风格输入，以下给出最小示例：

```bash
curl -X POST "$API_BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seed-translation",
    "input": [
      {"role":"system","content":"{\"target_language\":\"ja\"}"},
      {"role":"user","content":"Hello"}
    ],
    "stream": false
  }'
```

返回会保留更接近上游的结构，并补齐 `id/object/created/model/usage` 字段：

```json
{
  "id": "resp-...",
  "object": "response",
  "created": 1727000000,
  "model": "doubao-seed-translation",
  "output": [
    {
      "id": "msg-...",
      "type": "message",
      "role": "assistant",
      "content": [{"type":"output_text","text":"こんにちは"}]
    }
  ],
  "usage": {"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
}
```

### 2.4 /v1/responses（SSE 流式）

`/v1/responses` 的流式响应会原样透传上游的 SSE 事件：

```bash
curl -N -X POST "$API_BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seed-translation",
    "input": [
      {"role":"system","content":"{\"target_language\":\"ja\"}"},
      {"role":"user","content":"Hello"}
    ],
    "stream": true
  }'
```

输出示意（事件名由上游定义）：

```
event: response.created
data: {"response":{"created_at":1727000000}}

event: response.output_text.delta
data: {"delta":"こん"}

event: response.output_text.delta
data: {"delta":"にちは"}

event: response.completed
data: {"response":{"usage":{"input_tokens":...,"output_tokens":...,"total_tokens":...}}}
```

将每个 `response.output_text.delta` 事件里的 `delta` 字段按顺序拼接，即得到完整回复文本。

---

## 3. Node.js fetch 示例

以下示例适用于 Node.js 18+（内置 WHATWG fetch 与 Streams）。

### 3.1 chat/completions 非流式

```js
const res = await fetch(`${process.env.API_BASE}/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "doubao-seed-translation",
    messages: [
      { role: "system", content: "{\"target_language\":\"ja\"}" },
      { role: "user", content: "Hello" },
    ],
    stream: false,
  }),
});
const data = await res.json();
console.log(data.choices?.[0]?.message?.content);
```

### 3.2 chat/completions SSE 流式 + 文本拼接

```js
const resp = await fetch(`${process.env.API_BASE}/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "doubao-seed-translation",
    messages: [
      { role: "system", content: "{\\\"target_language\\\":\\\"ja\\\"}" },
      { role: "user", content: "Hello\nHow are you?" },
    ],
    stream: true,
  }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let fullText = "";

function handleEventLine(line) {
  if (!line.startsWith("data:")) return;
  const jsonStr = line.slice(5).trim();
  if (jsonStr === "[DONE]") {
    return;
  }
  const payload = JSON.parse(jsonStr);
  const delta = payload.choices?.[0]?.delta;
  if (delta?.content) fullText += delta.content;
}

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx).replace(/\r/g, "");
    buffer = buffer.slice(idx + 2);
    raw.split("\n").forEach(handleEventLine);
  }
}
console.log("final:", fullText);
```

### 3.3 responses 非流式

```js
const res = await fetch(`${process.env.API_BASE}/v1/responses`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "doubao-seed-translation",
    input: [
      { role: "system", content: "{\\\"target_language\\\":\\\"ja\\\"}" },
      { role: "user", content: "Hello" },
    ],
    stream: false,
  }),
});
const data = await res.json();
const text = data.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text;
console.log(text);
```

### 3.4 responses SSE 流式 + 文本拼接

```js
const resp = await fetch(`${process.env.API_BASE}/v1/responses`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "doubao-seed-translation",
    input: [
      { role: "system", content: "{\\\"target_language\\\":\\\"ja\\\"}" },
      { role: "user", content: "Hello" },
    ],
    stream: true,
  }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let fullText = "";
let eventName = "";
let dataLines = [];

function flushEvent() {
  if (!eventName && dataLines.length === 0) return;
  const dataStr = dataLines.join("\n");
  if (eventName === "response.output_text.delta") {
    const { delta } = JSON.parse(dataStr);
    if (delta) fullText += String(delta).replace(/\r/g, "");
  }
  eventName = "";
  dataLines = [];
}

function feedLine(line) {
  if (line.startsWith("event:")) {
    flushEvent();
    eventName = line.slice(6).trim();
  } else if (line.startsWith("data:")) {
    dataLines.push(line.slice(5).trim());
  }
}

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx).replace(/\r/g, "");
    buffer = buffer.slice(idx + 2);
    raw.split("\n").forEach(feedLine);
    flushEvent();
  }
}
console.log("final:", fullText);
```

---

## 4. 常见错误复现与排查

### 4.1 认证失败（401 invalid_api_key）

复现：缺少或未以 Bearer 形式传入 Authorization 头。

```bash
curl -X POST "$API_BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seed-translation","messages":[{"role":"user","content":"hi"}]}'
```

返回：

```json
{"error":{"message":"缺少 API 密钥","type":"invalid_request_error","code":"invalid_api_key"}}
```

排查：
- 确认使用了正确的上游 Token：`Authorization: Bearer $TOKEN`
- Token 不要泄露或硬编码到仓库；建议通过 CI/CD 或环境变量注入

### 4.2 请求过大（400 请求过大）

复现：请求体超过 24KB（`MAX_REQUEST_SIZE = 24 * 1024`）。

示例（构造一个 25KB 的文本）：

```bash
LARGE=$(python3 - <<'PY'
print('A' * 25000)
PY
)

curl -X POST "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"doubao-seed-translation\",\"messages\":[{\"role\":\"user\",\"content\":\"$LARGE\"}]}"
```

返回：

```json
{"error":{"message":"请求过大","type":"invalid_request_error"}}
```

排查：
- 压缩或截断超长文本；如需批量长文本翻译，建议切分后并发调用
- 确认客户端是否误加入冗余字段或调试日志导致请求体增大

> 另：若在非 HTTPS 环境直接请求边缘函数，会返回 `需要 HTTPS`。本地或反向代理环境可通过 `X-Forwarded-Proto: https` 模拟（见下一节 Docker 本地示例）。

---

## 5. 本地运行与 Docker 启动

项目提供 Go 自托管实现（与 EdgeOne 逻辑等价）。

### 5.1 本地直接运行（Go）

```bash
# 安装 Go 1.22+
cd go
PORT=8080 go run .
```

在另一个终端执行：

```bash
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-Proto: https" \
  -d '{"model":"doubao-seed-translation","messages":[{"role":"system","content":"{\"target_language\":\"ja\"}"},{"role":"user","content":"Hello"}],"stream":false}'
```

> 说明：示例中添加了 `X-Forwarded-Proto: https` 以模拟 HTTPS 场景，便于与边缘环境对齐。

### 5.2 Docker 启动

```bash
# 在仓库根目录
docker build -f go/Dockerfile -t doubao-proxy .

# 运行容器并监听 8080 端口
docker run --rm -p 8080:8080 -e PORT=8080 doubao-proxy
```

随后在宿主机请求：

```bash
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-Proto: https" \
  -d '{"model":"doubao-seed-translation","messages":[{"role":"system","content":"{\"target_language\":\"ja\"}"},{"role":"user","content":"Hello"}],"stream":false}'
```

---

## 6. 手工回归建议清单

- chat/completions 非流式：能返回 JSON，`choices[0].message.content` 为目标语言文本
- chat/completions 流式：SSE 块拼接后与非流式结果一致或仅差空白符
- responses 非流式：`output[0].content[0].text` 存在且非空，usage 字段补齐
- responses 流式：能持续收到 `response.output_text.delta` 事件并可正确拼接
- 缺失 Authorization：返回 401 invalid_api_key
- 超过 24KB：返回 400 请求过大
- 本地 Docker：通过 `X-Forwarded-Proto: https` 能正常请求

如需更多部署与语言映射说明，请参见仓库根目录的 README.md。
