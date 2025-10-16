# doubao-seed-translation-transformer

将豆包（doubao-seed-translation）模型的 API 接口转换为兼容 OpenAI Chat Completions API 的形式。通过腾讯 EdgeOne 边缘函数实现，无需服务器即可快速部署。

## 功能特性

- **兼容 OpenAI API**：完全兼容 OpenAI Chat Completions API 格式，支持流式和非流式响应。
- **翻译功能**：专门针对豆包翻译模型，支持指定源语言和目标语言。
- **智能语言识别**：支持多种语言名称格式（中文名、英文名、原语言名、语言编码），自动转换为模型所需格式。
- **边缘计算**：部署在腾讯 EdgeOne 上，实现低延迟、高可用性。
- **安全验证**：支持 Bearer 令牌认证，确保 API 安全。
- **错误处理**：完善的错误响应和日志记录。

## 快速开始

### 部署到腾讯 EdgeOne

1. 登录 [腾讯云控制台](https://console.cloud.tencent.com/)，进入 EdgeOne 服务。
2. 创建新的边缘函数，选择 JavaScript 运行时。
3. 将 `edge-function.js` 的代码复制到函数编辑器中。
4. 配置环境变量（如果需要）。
5. 部署函数并获取函数 URL。

### 使用 API

API 端点：`https://your-edgeone-domain.com/v1/chat/completions`

#### 请求示例

```json
{
  "model": "doubao-seed-translation",
  "messages": [
    {
      "role": "system",
      "content": "{\"source_language\": \"en\", \"target_language\": \"zh\"}"
    },
    {
      "role": "user",
      "content": "Hello, how are you?"
    }
  ],
  "stream": false
}
```

#### 响应示例

```json
{
  "id": "chatcmpl-abc123def456",
  "object": "chat.completion",
  "created": 1727000000,
  "model": "doubao-seed-translation",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好，你怎么样？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

## Go 自托管部署

`go/` 目录内提供了与边缘函数等价的 Go 版本实现，可用于自托管或在容器/虚拟机中运行。

### 本地运行

1. 安装 Go 1.22 或更新版本。
2. 进入 Go 项目目录：`cd go`
3. 启动服务：`go run .`
4. 默认监听 `8080` 端口，可通过环境变量 `PORT` 指定其他端口。

> ⚠️ 服务在本地运行时仍会校验 HTTPS。发送请求时请补充 `X-Forwarded-Proto: https` 头以模拟 EdgeOne：

```bash
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-Proto: https" \
  -d '{"model":"doubao-seed-translation","messages":[{"role":"system","content":"{\"target_language\":\"ja\"}"},{"role":"user","content":"Hello"}],"stream":false}'
```

### 构建二进制

```bash
cd go
go build -o doubao .
./doubao
```

构建输出位于 `go/doubao`，与 Node 版本保持相同的 API 兼容性。

### Docker 镜像

仓库提供 `go/Dockerfile` 以生成跨平台镜像：

```bash
docker build -f go/Dockerfile -t doubao-proxy .
docker run --rm -p 8080:8080 -e PORT=8080 doubao-proxy
```

镜像使用非 root 账户运行，默认监听 `PORT` 环境变量指定的端口。

### GitHub Actions 发布流程

`.github/workflows/ci.yml` 会在每次推送到 `main` 或创建 `v*` 标签时运行：

- 常规分支会执行 `gofmt`、`go vet`、单元测试及 Docker 构建。
- 推送 `v*` 标签时会额外交叉编译 Linux、macOS、Windows 的二进制包，并以 `tar.gz`/`zip` 形式上传到对应的 GitHub Release。

发布步骤示例：

```bash
git tag v1.0.0
git push origin v1.0.0
```

CI 成功后即可在 Releases 页面下载多平台构建产物，用于自托管部署。

## 配置翻译选项

翻译选项通过 `system` 角色的消息传递，支持 JSON 格式：

- `source_language`：源语言（可选，默认自动检测）
- `target_language`：目标语言（必填，默认 "zh"）

### 支持的语言格式

本服务支持多种语言名称格式，会自动转换为模型所需的标准编码：

1. **语言编码**：如 `zh`、`en`、`ja`
2. **中文名称**：如 `中文（简体）`、`英语`、`日语`
3. **英文名称**：如 `Chinese (simplified)`、`English`、`Japanese`
4. **原语言名称**：如 `简体中文`、`日本語`、`한국어`

### 支持的语言列表

| 语种中文名称 | 语种英文名称 | 原语言名称 | 编码 |
| :--- | :--- | :--- | :--- |
| 中文（简体） | Simplified Chinese | 简体中文 | zh |
| 中文（繁体） | Traditional Chinese | 繁體中文 | zh-Hant |
| 英语 | English | - | en |
| 日语 | Japanese | 日本語 | ja |
| 韩语 | Korean | 한국어 | ko |
| 德语 | German | Deutsch | de |
| 法语 | French | Français | fr |
| 西班牙语 | Spanish | Español | es |
| 意大利语 | Italian | Italiano | it |
| 葡萄牙语 | Portuguese | Português | pt |
| 俄语 | Russian | Русский | ru |
| 泰语 | Thai | ไทย | th |
| 越南语 | Vietnamese | Tiếng Việt | vi |
| 阿拉伯语 | Arabic | العربية | ar |
| 捷克语 | Czech | Čeština | cs |
| 丹麦语 | Danish | Dansk | da |
| 芬兰语 | Finnish | Suomi | fi |
| 克罗地亚语 | Croatian | Hrvatski | hr |
| 匈牙利语 | Hungarian | Magyar | hu |
| 印尼语 | Indonesian | Bahasa Indonesia | id |
| 马来语 | Malay | Bahasa Melayu | ms |
| 挪威布克莫尔语 | Norwegian Bokmål | Norsk Bokmål | nb |
| 荷兰语 | Dutch | Nederlands | nl |
| 波兰语 | Polish | Polski | pl |
| 罗马尼亚语 | Romanian | Română | ro |
| 瑞典语 | Swedish | Svenska | sv |
| 土耳其语 | Turkish | Türkçe | tr |
| 乌克兰语 | Ukrainian | Українська | uk |

### 配置示例

以下示例展示了不同的语言名称格式，都会被正确识别和转换：

**使用语言编码：**
```json
{
  "role": "system",
  "content": "{\"source_language\": \"en\", \"target_language\": \"zh\"}"
}
```

**使用中文名称：**
```json
{
  "role": "system", 
  "content": "{\"source_language\": \"英语\", \"target_language\": \"中文（简体）\"}"
}
```

**使用英文名称：**
```json
{
  "role": "system",
  "content": "{\"source_language\": \"English\", \"target_language\": \"Japanese\"}"
}
```

**使用原语言名称：**
```json
{
  "role": "system",
  "content": "{\"source_language\": \"English\", \"target_language\": \"日本語\"}"
}
```

**混合使用：**
```json
{
  "role": "system",
  "content": "{\"source_language\": \"英语\", \"target_language\": \"ja\"}"
}
```

## 错误处理

函数返回标准 OpenAI 错误格式，包括：

- 400：请求错误（如缺少参数、无效 JSON）
- 401：认证失败
- 404：路径不存在
- 500：服务器或上游 API 错误

## 开发与贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 此仓库。
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -am 'Add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 Pull Request。

## 许可证

此项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。

## 相关链接

- [腾讯 EdgeOne 文档](https://cloud.tencent.com/document/product/1552)
- [豆包模型 API 文档](https://www.volcengine.com/docs)
