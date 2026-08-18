# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

由 [Tavily](https://tavily.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Tavily 的 `POST /search` 检索端点，把扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，每次搜索通过可选的 `ctx.credentials` seam 解析凭据，不注册面向模型的工具。与 `@deepseek-ai/dsh-web-search-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`）。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面量 Tavily API 密钥。优先使用 `apiKeyEnv`，避免密钥进入配置；非空字面量优先生效。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；未挂载该 seam 时从进程环境读取。缺失时调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic` 或 `advanced`。 |
| `maxResults` | 省略 | 请求不含 `maxResults` 时使用的默认结果数。未设置时不发送默认值。必须是正整数。 |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

以上条目是 `web-search-tavily` Settings 节的组合层：用户层覆盖会作用于下一次搜索，因为提供方按次投影该节，而不是在注册时捕获。`apiKey` 带有 `role('secret')`，因此不会出现在任何层的 `describe()` 响应中。

已交付的 `dsh-base` 组合不挂载本包。要用 Tavily 替换 DeepSeek 搜索的 profile 应插入此行，并在 `web` 行上设置 `searchProvider: tavily`。

## 映射

Tavily 返回扁平 `results[]` 以及可选的生成答案；生成答案会被丢弃，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`、`publishedAt` ← `published_date`。没有可用 URL 的结果会被丢弃；有 URL 但没有 snippet 的结果会保留。结果按 URL 去重。请求的 `maxResults` 优先于已配置的默认值，并作为 Tavily `max_results` 发送；seam 仍在返回时强制执行上限。

提供方失败以 `WEB_PROVIDER_ERROR` 呈现；调用方取消以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。缺少凭据时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、snippet 与发布日期，或将确切的错误消息 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily search credential resolution failed: <error>`、`Tavily search has no API key for "<ref>"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config` 和 `Tavily returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **Tavily 的生成答案会被丢弃**：它不是可引用的来源，因此 seam 的可选 `content` 保持为空。
- **只公开 `searchDepth` 与 `maxResults`**：Tavily 的其他控制项（topic、时间范围、域名过滤、extract）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError`，或调用方信号已经中止时，才映射为 `WEB_ABORTED`；`fetch` 本身携带自定义原因的中止可能呈现为 `WEB_PROVIDER_ERROR`。
