# Agent Note: web seam 的 Tavily 搜索提供方

Status: implemented

[English](2026-08-18-web-search-tavily.md) | 中文

## 问题

已交付组合将 `web_search` 钉在 DeepSeek 的 Anthropic 兼容 Messages 原生工具上。该路径需要 `DEEPSEEK_API_KEY`，以及会返回 `web_search_tool_result` 的后端。已经通过本地 OpenAI／Anthropic 网关为会话付费、并且已持有 Tavily 检索密钥的部署，无法在不另购一次 DeepSeek Messages 调用的情况下使用 `web_search`。把 `web-search-deepseek` 的 `baseURL` 指到会话网关会失败：网关返回的是普通 `tool_use`，而不是原生搜索结果块。

## 决策

`@deepseek-ai/dsh-web-search-tavily` 是 `ctx.web` 上的第四个搜索 Service Provider。它注册 id `tavily`，以 `search_depth` 和 `include_answer: false` 调用 `POST {baseURL}/search`，并把 `results[]` 映射为 `WebSearchSource`（`url`、`title`、`snippet` ← `content`、`publishedAt` ← `published_date`）。生成答案会被丢弃。面向模型的 `web_search` schema 仍由 `dsh-tool-web` 持有。

凭据遵循 DeepSeek 搜索路径，而不是 Exa：每次搜索先快照 Settings 节，再通过 `ctx.credentials` 解析 `apiKeyEnv`（默认 `TAVILY_API_KEY`）；未挂载该 seam 时从启动环境读取。非空字面量 `apiKey` 优先生效。`available()` 将已安装的解析器视为本地可用；缺少密钥时操作以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，而工具 schema 仍保持注册。

`dsh-base` 仍钉 `searchProvider: deepseek-official`，并且仍只挂载 `dsh-web-search-deepseek`。要用 Tavily 的 profile 插入本包，并在 `web` 行上设置 `searchProvider: tavily`。已交付的一分钟 DeepSeek 搜索超时不会被继承；除非覆盖层另行声明，Tavily 使用 `dsh-tool-web` 提供方无关的 30 秒默认值。

## 考虑过的替代方案

**把 `web-search-deepseek` 指到会话网关。** 不予采纳：该提供方要求原生 `web_search_20250305` 结果块。只讲普通 Anthropic Messages 的网关会返回 `tool_use`，并导致提供方的严格映射失败。

**让会话网关假扮 DeepSeek 原生搜索。** 不予采纳：每次搜索仍会消耗一整轮模型调用，而且协议会落在错误的所有者上。

**像 cc-haha 的 `auto` 模式那样，按会话模型名选择搜索后端。** 不予采纳：`ctx.web` 已经通过已配置的提供方 id 拥有选择权。按模型名猜测，以及从原生搜索回退到 Tavily，会让一次搜索的协议与费用取决于运行时失败。

**把 Tavily 折进 `dsh-tool-web`。** 不予采纳：提供方注册的是能力，不是工具。更换厂商不得改变模型 schema。

**在 `dsh-base` 中挂载 Tavily，或更改已交付的 `searchProvider`。** 不予采纳：产品默认仍是 DeepSeek 原生搜索。本地检索密钥属于 profile 覆盖层，而不是新的已交付默认值。

**在同一次变更中打开 `web_fetch`。** 不予采纳：搜索负责发现；默认抓取会让模型检索任意 URL。Tavily extract 不进入本提供方。

## 后果

持有 Tavily 密钥的部署可以钉 `searchProvider: tavily`，并把会话留在无关的 LLM 路由上。每次 `web_search` 是一次检索 HTTP 调用，而不是辅助模型回合。已交付的 DeepSeek 默认值、其 60 秒预算及其会话日志请求事件保持不变。`web-search-tavily` 没有 Plugins 设置卡片，也没有 `apiproxy` 白名单条目；已存储的节仍可通过设置文档生效。提供方测试固定映射、请求体、中止与 HTTP 失败、按次凭据轮换，以及 Settings 节投影。
