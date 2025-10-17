package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	DoubaoBaseURL         string
	DefaultTargetLanguage string
	MaxRequestSize        int64
}

var CONFIG = config{
	DoubaoBaseURL:         "https://ark.cn-beijing.volces.com/api/v3/responses",
	DefaultTargetLanguage: "zh",
	MaxRequestSize:        24 * 1024,
}

var errorTemplates = map[string]string{
	"https":       "{\"error\":{\"message\":\"需要 HTTPS\",\"type\":\"security_error\"}}",
	"notFound":    "{\"error\":{\"message\":\"Not Found\",\"type\":\"invalid_request_error\"}}",
	"noAuth":      "{\"error\":{\"message\":\"缺少 API 密钥\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}",
	"tooLarge":    "{\"error\":{\"message\":\"请求过大\",\"type\":\"invalid_request_error\"}}",
	"noMessage":   "{\"error\":{\"message\":\"无用户消息\",\"type\":\"invalid_request_error\"}}",
	"noModel":     "{\"error\":{\"message\":\"缺少 model\",\"type\":\"invalid_request_error\"}}",
	"invalidJson": "{\"error\":{\"message\":\"无效 JSON\",\"type\":\"invalid_request_error\"}}",
	"serverError": "{\"error\":{\"message\":\"内部服务错误\",\"type\":\"api_error\"}}",
}

var upstreamErrorTemplate = "{\"error\":{\"message\":\"上游 API 错误：%s\",\"type\":\"api_error\"}}"

var idSource = rand.New(rand.NewSource(time.Now().UnixNano()))
var idMutex sync.Mutex

func genID(prefix string) string {
	if prefix == "" {
		prefix = "chatcmpl"
	}
	idMutex.Lock()
	defer idMutex.Unlock()
	return fmt.Sprintf("%s-%s-%s", prefix, strconv.FormatInt(time.Now().UnixNano(), 36), randomString(10))
}

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomString(length int) string {
	b := make([]byte, length)
	for i := 0; i < length; i++ {
		b[i] = idAlphabet[idSource.Intn(len(idAlphabet))]
	}
	return string(b)
}

type server struct {
	client *http.Client
}

func newServer() *server {
	return &server{
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, errorTemplates["notFound"])
		return
	}

	if r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/v1/responses" {
		writeError(w, http.StatusNotFound, errorTemplates["notFound"])
		return
	}

	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		writeError(w, http.StatusUnauthorized, errorTemplates["noAuth"])
		return
	}

	if cl := r.Header.Get("Content-Length"); cl != "" {
		if parsed, err := strconv.ParseInt(cl, 10, 64); err == nil && parsed > CONFIG.MaxRequestSize {
			writeError(w, http.StatusBadRequest, errorTemplates["tooLarge"])
			return
		}
	}

	limited := http.MaxBytesReader(w, r.Body, CONFIG.MaxRequestSize)
	defer limited.Close()

	body, err := io.ReadAll(limited)
	if err != nil {
		if errors.Is(err, http.ErrBodyReadAfterClose) || errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, errorTemplates["invalidJson"])
			return
		}
		if strings.Contains(err.Error(), "http: request body too large") {
			writeError(w, http.StatusBadRequest, errorTemplates["tooLarge"])
			return
		}
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	switch r.URL.Path {
	case "/v1/chat/completions":
		s.handleChatCompletions(w, body, auth)
	case "/v1/responses":
		s.handleResponses(w, body, auth)
	}
}

type messageInput struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type chatCompletionsRequest struct {
	Model              string         `json:"model"`
	Messages           []messageInput `json:"messages"`
	TranslationOptions interface{}    `json:"translation_options"`
	Metadata           interface{}    `json:"metadata"`
	Stream             interface{}    `json:"stream"`
}

type responsesRequest struct {
	Model              string      `json:"model"`
	Input              interface{} `json:"input"`
	TranslationOptions interface{} `json:"translation_options"`
	Metadata           interface{} `json:"metadata"`
	Stream             interface{} `json:"stream"`
}

type translationOptions struct {
	SourceLanguage *string `json:"source_language,omitempty"`
	TargetLanguage string  `json:"target_language"`
}

type doubaoUsage struct {
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	TotalTokens      int `json:"total_tokens"`
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type doubaoError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

type doubaoContent struct {
	Type    string      `json:"type"`
	Text    string      `json:"text"`
	Content interface{} `json:"content"`
}

type doubaoOutput struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content []doubaoContent `json:"content"`
}

type doubaoResponse struct {
	ID      string         `json:"id"`
	Object  string         `json:"object"`
	Created int64          `json:"created"`
	Model   string         `json:"model"`
	Output  []doubaoOutput `json:"output"`
	Usage   *doubaoUsage   `json:"usage"`
	Error   *doubaoError   `json:"error"`
}

func (s *server) handleChatCompletions(w http.ResponseWriter, body []byte, auth string) {
	var req chatCompletionsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, errorTemplates["invalidJson"])
		return
	}

	if req.Model == "" {
		writeError(w, http.StatusBadRequest, errorTemplates["noModel"])
		return
	}

	var userContent interface{}
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if strings.EqualFold(req.Messages[i].Role, "user") {
			userContent = req.Messages[i].Content
			break
		}
	}
	if userContent == nil {
		writeError(w, http.StatusBadRequest, errorTemplates["noMessage"])
		return
	}

	var systemPrompt string
	for _, msg := range req.Messages {
		if strings.EqualFold(msg.Role, "system") {
			systemPrompt = extractTextFromContent(msg.Content)
			if systemPrompt != "" {
				break
			}
		}
	}

	translationOptions := parseTranslationOptions(systemPrompt)
	mergeTranslationOverrides(&translationOptions, req.TranslationOptions, req.Metadata)
	isStream := parseStreamFlag(req.Stream)

	payload := buildDoubaoPayload(req.Model, translationOptions, userContent, isStream)
	upstream, err := s.sendDoubaoRequest(payload, auth)
	if err != nil {
		writeError(w, http.StatusInternalServerError, formatUpstreamError(err.Error()))
		return
	}

	if isStream && upstream.Header.Get("Content-Type") == "text/event-stream" {
		s.streamDoubaoResponse(w, upstream, req.Model)
		return
	}

	defer upstream.Body.Close()
	responseBytes, err := io.ReadAll(upstream.Body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		writeError(w, upstream.StatusCode, formatUpstreamError(extractUpstreamError(responseBytes)))
		return
	}

	var parsed doubaoResponse
	if err := json.Unmarshal(responseBytes, &parsed); err != nil {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	if parsed.Error != nil {
		writeError(w, http.StatusInternalServerError, formatUpstreamError(parsed.Error.Message))
		return
	}

	messageContent := findAssistantMessage(parsed)
	if messageContent == "" {
		writeError(w, http.StatusInternalServerError, formatUpstreamError("未找到有效的翻译结果"))
		return
	}

	openai := map[string]interface{}{
		"id":      genID("chatcmpl"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   req.Model,
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"message": map[string]interface{}{
					"role":    "assistant",
					"content": messageContent,
				},
				"finish_reason": "stop",
			},
		},
		"usage": map[string]int{
			"prompt_tokens":     usageInputTokens(parsed.Usage),
			"completion_tokens": usageOutputTokens(parsed.Usage),
			"total_tokens":      usageTotalTokens(parsed.Usage),
		},
	}

	writeJSON(w, http.StatusOK, openai)
}

func (s *server) handleResponses(w http.ResponseWriter, body []byte, auth string) {
	var req responsesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, errorTemplates["invalidJson"])
		return
	}

	if req.Model == "" {
		writeError(w, http.StatusBadRequest, errorTemplates["noModel"])
		return
	}

	systemPrompt, userContent := parseResponsesInput(req.Input)
	if userContent == nil {
		writeError(w, http.StatusBadRequest, errorTemplates["noMessage"])
		return
	}

	translationOptions := parseTranslationOptions(systemPrompt)
	mergeTranslationOverrides(&translationOptions, req.TranslationOptions, req.Metadata)
	isStream := parseStreamFlag(req.Stream)

	payload := buildDoubaoPayload(req.Model, translationOptions, userContent, isStream)
	upstream, err := s.sendDoubaoRequest(payload, auth)
	if err != nil {
		writeError(w, http.StatusInternalServerError, formatUpstreamError(err.Error()))
		return
	}

	if isStream && upstream.Header.Get("Content-Type") == "text/event-stream" {
		s.streamResponses(w, upstream)
		return
	}

	defer upstream.Body.Close()
	responseBytes, err := io.ReadAll(upstream.Body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		writeError(w, upstream.StatusCode, formatUpstreamError(extractUpstreamError(responseBytes)))
		return
	}

	var parsed doubaoResponse
	if err := json.Unmarshal(responseBytes, &parsed); err != nil {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	if parsed.Error != nil {
		writeError(w, http.StatusInternalServerError, formatUpstreamError(parsed.Error.Message))
		return
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(responseBytes, &raw); err != nil {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	ensureResponsesFields(raw, parsed, req.Model)
	writeJSON(w, http.StatusOK, raw)
}

func (s *server) sendDoubaoRequest(payload map[string]interface{}, auth string) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, CONFIG.DoubaoBaseURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}

	defer resp.Body.Close()
	responseBytes, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, fmt.Errorf("%s", resp.Status)
	}
	return nil, fmt.Errorf("%s", extractUpstreamError(responseBytes))
}

func ensureResponsesFields(raw map[string]interface{}, parsed doubaoResponse, requestModel string) {
	if raw == nil {
		raw = map[string]interface{}{}
	}

	if _, ok := raw["id"].(string); !ok || raw["id"] == "" {
		raw["id"] = genID("resp")
	}
	if _, ok := raw["object"].(string); !ok || raw["object"] == "" {
		raw["object"] = "response"
	}
	if _, ok := raw["created"].(float64); !ok {
		raw["created"] = float64(time.Now().Unix())
	}
	raw["model"] = requestModel

	usage := parsed.Usage
	raw["usage"] = map[string]int{
		"prompt_tokens":     usagePromptTokens(usage),
		"completion_tokens": usageCompletionTokens(usage),
		"total_tokens":      usageTotalFromUsage(usage),
	}

	if outputs, ok := raw["output"].([]interface{}); !ok || len(outputs) == 0 {
		messageContent := findAssistantMessage(parsed)
		if messageContent != "" {
			raw["output"] = []map[string]interface{}{
				{
					"id":   genID("msg"),
					"type": "message",
					"role": "assistant",
					"content": []map[string]interface{}{
						{
							"type": "output_text",
							"text": messageContent,
						},
					},
				},
			}
		} else {
			raw["output"] = []interface{}{}
		}
	}
}

func parseResponsesInput(input interface{}) (string, interface{}) {
	var systemPrompt string
	var userContent interface{}

	handleSegment := func(segment map[string]interface{}) {
		if segment == nil {
			return
		}
		role, _ := segment["role"].(string)
		rawContent, ok := segment["content"]
		if !ok {
			if v, ok := segment["input"]; ok {
				rawContent = v
			} else if v, ok := segment["text"].(string); ok {
				rawContent = v
			} else if v, ok := segment["value"]; ok {
				rawContent = v
			}
		}
		text := extractTextFromContent(rawContent)
		if role == "system" && text != "" && systemPrompt == "" {
			systemPrompt = text
			return
		}
		if (role == "" || role == "user") && text != "" && userContent == nil {
			userContent = rawContent
		}
	}

	switch val := input.(type) {
	case string:
		userContent = val
	case []interface{}:
		for _, segment := range val {
			switch seg := segment.(type) {
			case string:
				if userContent == nil {
					userContent = seg
				}
			case map[string]interface{}:
				handleSegment(seg)
			}
		}
	case map[string]interface{}:
		handleSegment(val)
	}

	return systemPrompt, userContent
}

func buildDoubaoPayload(model string, options translationOptions, userContent interface{}, isStream bool) map[string]interface{} {
	text := stringifyUserContent(userContent)

	inputContent := map[string]interface{}{
		"type":                "input_text",
		"text":                text,
		"translation_options": options,
	}

	payload := map[string]interface{}{
		"model": model,
		"input": []map[string]interface{}{
			{
				"role":    "user",
				"content": []map[string]interface{}{inputContent},
			},
		},
	}

	if isStream {
		payload["stream"] = true
	}

	return payload
}

func stringifyUserContent(content interface{}) string {
	switch val := content.(type) {
	case string:
		return val
	case fmt.Stringer:
		return val.String()
	default:
		bytes, err := json.Marshal(val)
		if err != nil {
			return fmt.Sprintf("%v", val)
		}
		return string(bytes)
	}
}

func parseStreamFlag(stream interface{}) bool {
	switch val := stream.(type) {
	case bool:
		return val
	case string:
		return strings.EqualFold(val, "true")
	default:
		return false
	}
}

func extractTextFromContent(content interface{}) string {
	switch val := content.(type) {
	case string:
		return val
	case []interface{}:
		for _, part := range val {
			text := extractTextFromContent(part)
			if text != "" {
				return text
			}
		}
	case map[string]interface{}:
		if text, ok := val["text"].(string); ok && text != "" {
			return text
		}
		if text, ok := val["content"].(string); ok && text != "" {
			return text
		}
		if nested, ok := val["content"].([]interface{}); ok {
			return extractTextFromContent(nested)
		}
	}
	return ""
}

func parseTranslationOptions(systemPrompt string) translationOptions {
	options := translationOptions{TargetLanguage: CONFIG.DefaultTargetLanguage}
	if systemPrompt == "" {
		return options
	}

	if parsed, err := parseTranslationJSON(systemPrompt); err == nil {
		applyLanguageOption(&options, parsed)
		return options
	}

	applyLanguageOption(&options, parseTranslationKV(systemPrompt))
	return options
}

func parseTranslationJSON(input string) (map[string]string, error) {
	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(input), &parsed); err != nil {
		return nil, err
	}
	result := map[string]string{}
	for key, value := range parsed {
		if str, ok := toString(value); ok {
			result[key] = str
		}
	}
	return result, nil
}

var reSourceLanguage = regexp.MustCompile(`source_language\s*:\s*['\"]?([^'\"]+)['\"]?`)
var reTargetLanguage = regexp.MustCompile(`target_language\s*:\s*['\"]?([^'\"]+)['\"]?`)

func parseTranslationKV(input string) map[string]string {
	result := map[string]string{}
	if matches := reSourceLanguage.FindStringSubmatch(input); len(matches) > 1 {
		result["source_language"] = matches[1]
	}
	if matches := reTargetLanguage.FindStringSubmatch(input); len(matches) > 1 {
		result["target_language"] = matches[1]
	}
	return result
}

func applyLanguageOption(options *translationOptions, values map[string]string) {
	if values == nil {
		return
	}
	if rawSource, ok := values["source_language"]; ok {
		if converted := getLanguageCode(rawSource); converted != "" {
			options.SourceLanguage = &converted
		}
	}
	if rawTarget, ok := values["target_language"]; ok {
		if converted := getLanguageCode(rawTarget); converted != "" {
			options.TargetLanguage = converted
		}
	}
}

func mergeTranslationOverrides(target *translationOptions, sources ...interface{}) {
	for _, src := range sources {
		candidate := extractCandidate(src)
		if candidate == nil {
			continue
		}
		if rawSource, ok := candidate["source_language"]; ok {
			if str, ok := toString(rawSource); ok {
				if converted := getLanguageCode(str); converted != "" {
					target.SourceLanguage = &converted
				}
			}
		}
		if rawTarget, ok := candidate["target_language"]; ok {
			if str, ok := toString(rawTarget); ok {
				if converted := getLanguageCode(str); converted != "" {
					target.TargetLanguage = converted
				}
			}
		}
	}
}

func extractCandidate(source interface{}) map[string]interface{} {
	rawMap, ok := source.(map[string]interface{})
	if !ok || rawMap == nil {
		return nil
	}

	if translationOptions, ok := rawMap["translation_options"].(map[string]interface{}); ok {
		return translationOptions
	}

	return rawMap
}

func getLanguageCode(lang string) string {
	if lang == "" {
		return ""
	}
	normalized := strings.TrimSpace(strings.ToLower(lang))
	for _, language := range languages {
		for _, name := range language.Names {
			if normalized == strings.ToLower(name) {
				return language.Code
			}
		}
	}
	return lang
}

type languageEntry struct {
	Code  string
	Names []string
}

var languages = []languageEntry{
	{Code: "zh", Names: []string{"中文（简体）", "simplified chinese", "简体中文", "chinese", "zh"}},
	{Code: "zh-Hant", Names: []string{"中文（繁体）", "traditional chinese", "繁體中文", "zh-hant"}},
	{Code: "en", Names: []string{"英语", "english", "en"}},
	{Code: "ja", Names: []string{"日语", "japanese", "日本語", "ja"}},
	{Code: "ko", Names: []string{"韩语", "korean", "한국어", "ko"}},
	{Code: "de", Names: []string{"德语", "german", "deutsch", "de"}},
	{Code: "fr", Names: []string{"法语", "french", "français", "fr"}},
	{Code: "es", Names: []string{"西班牙语", "spanish", "español", "es"}},
	{Code: "it", Names: []string{"意大利语", "italian", "italiano", "it"}},
	{Code: "pt", Names: []string{"葡萄牙语", "portuguese", "português", "pt"}},
	{Code: "ru", Names: []string{"俄语", "russian", "русский", "ru"}},
	{Code: "th", Names: []string{"泰语", "thai", "ไทย", "th"}},
	{Code: "vi", Names: []string{"越南语", "vietnamese", "tiếng việt", "vi"}},
	{Code: "ar", Names: []string{"阿拉伯语", "arabic", "العربية", "ar"}},
	{Code: "cs", Names: []string{"捷克语", "czech", "čeština", "cs"}},
	{Code: "da", Names: []string{"丹麦语", "danish", "dansk", "da"}},
	{Code: "fi", Names: []string{"芬兰语", "finnish", "suomi", "fi"}},
	{Code: "hr", Names: []string{"克罗地亚语", "croatian", "hrvatski", "hr"}},
	{Code: "hu", Names: []string{"匈牙利语", "hungarian", "magyar", "hu"}},
	{Code: "id", Names: []string{"印尼语", "indonesian", "bahasa indonesia", "id"}},
	{Code: "ms", Names: []string{"马来语", "malay", "bahasa melayu", "ms"}},
	{Code: "nb", Names: []string{"挪威布克莫尔语", "norwegian bokmål", "norsk bokmål", "nb"}},
	{Code: "nl", Names: []string{"荷兰语", "dutch", "nederlands", "nl"}},
	{Code: "pl", Names: []string{"波兰语", "polish", "polski", "pl"}},
	{Code: "ro", Names: []string{"罗马尼亚语", "romanian", "română", "ro"}},
	{Code: "sv", Names: []string{"瑞典语", "swedish", "svenska", "sv"}},
	{Code: "tr", Names: []string{"土耳其语", "turkish", "türkçe", "tr"}},
	{Code: "uk", Names: []string{"乌克兰语", "ukrainian", "українська", "uk"}},
}

func findAssistantMessage(response doubaoResponse) string {
	for _, output := range response.Output {
		if output.Type == "message" && output.Role == "assistant" {
			for _, content := range output.Content {
				if content.Type == "output_text" && content.Text != "" {
					return content.Text
				}
			}
		}
	}
	return ""
}

func usageInputTokens(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	return usage.InputTokens
}

func usageOutputTokens(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	return usage.OutputTokens
}

func usageTotalTokens(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	if usage.TotalTokens != 0 {
		return usage.TotalTokens
	}
	return usage.InputTokens + usage.OutputTokens
}

func usagePromptTokens(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	if usage.PromptTokens != 0 {
		return usage.PromptTokens
	}
	return usage.InputTokens
}

func usageCompletionTokens(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	if usage.CompletionTokens != 0 {
		return usage.CompletionTokens
	}
	return usage.OutputTokens
}

func usageTotalFromUsage(usage *doubaoUsage) int {
	if usage == nil {
		return 0
	}
	if usage.TotalTokens != 0 {
		return usage.TotalTokens
	}
	return usage.InputTokens + usage.OutputTokens
}

func (s *server) streamResponses(w http.ResponseWriter, upstream *http.Response) {
	defer upstream.Body.Close()

	ct := upstream.Header.Get("Content-Type")
	if ct == "" {
		ct = "text/event-stream"
	}
	cacheCtrl := upstream.Header.Get("Cache-Control")
	if cacheCtrl == "" {
		cacheCtrl = "no-cache"
	}
	conn := upstream.Header.Get("Connection")
	if conn == "" {
		conn = "keep-alive"
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", cacheCtrl)
	w.Header().Set("Connection", conn)
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	reader := bufio.NewReader(upstream.Body)
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("streamResponses read error: %v", err)
			}
			return
		}
	}
}

func (s *server) streamDoubaoResponse(w http.ResponseWriter, upstream *http.Response, modelID string) {
	defer upstream.Body.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errorTemplates["serverError"])
		return
	}

	streamID := genID("chatcmpl")
	createdAt := time.Now().Unix()
	sentRoleChunk := false
	closed := false
	var buffer strings.Builder
	bufferedNewlines := ""

	enqueue := func(payload map[string]interface{}) {
		data, err := json.Marshal(payload)
		if err != nil {
			log.Printf("failed to marshal stream payload: %v", err)
			return
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			closed = true
			return
		}
		flusher.Flush()
	}

	enqueueDone := func() {
		if closed {
			return
		}
		if _, err := io.WriteString(w, "data: [DONE]\n\n"); err == nil {
			flusher.Flush()
		}
		closed = true
	}

	usageFromDoubao := func(usage *doubaoUsage) map[string]int {
		if usage == nil {
			return nil
		}
		return map[string]int{
			"prompt_tokens":     usageInputTokens(usage),
			"completion_tokens": usageOutputTokens(usage),
			"total_tokens":      usageTotalTokens(usage),
		}
	}

	reader := bufio.NewReader(upstream.Body)
	temp := make([]byte, 4096)

	handleEvent := func(eventName, dataStr string) {
		if dataStr == "" {
			return
		}
		if dataStr == "[DONE]" {
			enqueueDone()
			return
		}

		var eventData map[string]interface{}
		if err := json.Unmarshal([]byte(dataStr), &eventData); err != nil {
			log.Printf("failed to parse SSE chunk: %v", err)
			return
		}

		switch eventName {
		case "response.created":
			if response, ok := eventData["response"].(map[string]interface{}); ok {
				if createdVal, ok := response["created_at"].(float64); ok {
					createdAt = int64(createdVal)
				}
			}
		case "response.output_text.delta":
			delta, _ := toString(eventData["delta"])
			delta = strings.ReplaceAll(delta, "\r", "")
			if delta == "" {
				return
			}

			if !sentRoleChunk {
				enqueue(map[string]interface{}{
					"id":      streamID,
					"object":  "chat.completion.chunk",
					"created": createdAt,
					"model":   modelID,
					"choices": []map[string]interface{}{
						{
							"index":         0,
							"delta":         map[string]interface{}{"role": "assistant"},
							"finish_reason": nil,
						},
					},
				})
				sentRoleChunk = true
			}

			if trimmed := strings.Trim(delta, "\n"); trimmed == "" {
				bufferedNewlines += delta
				return
			}

			leadingNewlines := countLeadingNewlines(delta)
			trailingNewlines := countTrailingNewlines(delta)
			contentStart := leadingNewlines
			contentEnd := len(delta) - trailingNewlines
			if contentEnd < contentStart {
				contentEnd = contentStart
			}
			coreContent := delta[contentStart:contentEnd]

			var emit strings.Builder
			if bufferedNewlines != "" {
				emit.WriteString(bufferedNewlines)
				bufferedNewlines = ""
			}
			if leadingNewlines > 0 {
				emit.WriteString(strings.Repeat("\n", leadingNewlines))
			}
			if coreContent != "" {
				emit.WriteString(coreContent)
			}

			if emit.Len() > 0 {
				enqueue(map[string]interface{}{
					"id":      streamID,
					"object":  "chat.completion.chunk",
					"created": createdAt,
					"model":   modelID,
					"choices": []map[string]interface{}{
						{
							"index":         0,
							"delta":         map[string]interface{}{"content": emit.String()},
							"finish_reason": nil,
						},
					},
				})
			}

			bufferedNewlines = strings.Repeat("\n", trailingNewlines)
		case "response.completed":
			var usage map[string]int
			if response, ok := eventData["response"].(map[string]interface{}); ok {
				if usageMap, ok := response["usage"].(map[string]interface{}); ok {
					usage = map[string]int{
						"prompt_tokens":     intFromInterface(usageMap["input_tokens"]),
						"completion_tokens": intFromInterface(usageMap["output_tokens"]),
						"total_tokens":      intFromInterface(usageMap["total_tokens"]),
					}
				}
			}
			bufferedNewlines = ""
			payload := map[string]interface{}{
				"id":      streamID,
				"object":  "chat.completion.chunk",
				"created": createdAt,
				"model":   modelID,
				"choices": []map[string]interface{}{
					{
						"index":         0,
						"delta":         map[string]interface{}{},
						"finish_reason": "stop",
					},
				},
			}
			if usage == nil {
				usage = usageFromDoubao(nil)
			}
			if usage != nil {
				payload["usage"] = usage
			}
			enqueue(payload)
			enqueueDone()
		}
	}

	processBuffer := func() {
		for {
			current := buffer.String()
			idx := strings.Index(current, "\n\n")
			if idx == -1 {
				break
			}
			rawEvent := strings.ReplaceAll(current[:idx], "\r", "")
			remaining := current[idx+2:]
			buffer.Reset()
			buffer.WriteString(remaining)
			if strings.TrimSpace(rawEvent) == "" {
				continue
			}
			lines := strings.Split(rawEvent, "\n")
			eventName := ""
			dataLines := make([]string, 0)
			for _, line := range lines {
				if strings.HasPrefix(line, "event:") {
					eventName = strings.TrimSpace(line[6:])
				} else if strings.HasPrefix(line, "data:") {
					dataLines = append(dataLines, strings.TrimSpace(line[5:]))
				}
			}
			handleEvent(eventName, strings.Join(dataLines, "\n"))
		}
	}

	for {
		n, err := reader.Read(temp)
		if n > 0 {
			buffer.Write(temp[:n])
			processBuffer()
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("streamDoubaoResponse read error: %v", err)
			}
			processBuffer()
			enqueueDone()
			return
		}
	}
}

func countLeadingNewlines(input string) int {
	count := 0
	for _, r := range input {
		if r == '\n' {
			count++
		} else {
			break
		}
	}
	return count
}

func countTrailingNewlines(input string) int {
	count := 0
	for i := len(input) - 1; i >= 0; i-- {
		if input[i] == '\n' {
			count++
		} else {
			break
		}
	}
	return count
}

func toString(value interface{}) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case fmt.Stringer:
		return v.String(), true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case int:
		return strconv.Itoa(v), true
	case json.Number:
		return v.String(), true
	default:
		return "", false
	}
}

func intFromInterface(value interface{}) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		i, _ := v.Int64()
		return int(i)
	default:
		return 0
	}
}

func extractUpstreamError(body []byte) string {
	var parsed map[string]interface{}
	if err := json.Unmarshal(body, &parsed); err == nil {
		if errObj, ok := parsed["error"].(map[string]interface{}); ok {
			if msg, ok := toString(errObj["message"]); ok {
				return msg
			}
		}
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed != "" {
		return trimmed
	}
	return "上游接口错误"
}

func formatUpstreamError(message string) string {
	if message == "" {
		message = "未知错误"
	}
	return fmt.Sprintf(upstreamErrorTemplate, escapeJSONString(message))
}

func escapeJSONString(input string) string {
	b, err := json.Marshal(input)
	if err != nil {
		return input
	}
	// json.Marshal wraps with quotes; trim them.
	if len(b) >= 2 {
		return string(b[1 : len(b)-1])
	}
	return input
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write json response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, body string) {
	if body == "" {
		body = errorTemplates["serverError"]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := io.WriteString(w, body); err != nil {
		log.Printf("failed to write error response: %v", err)
	}
}

func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	if r.URL != nil && r.URL.Scheme == "https" {
		return true
	}
	return false
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newServer(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("Doubao translation proxy listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}
