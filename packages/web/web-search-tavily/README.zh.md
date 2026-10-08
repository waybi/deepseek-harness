---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载按次解析凭据的 web 搜索，并丢弃生成答案、只保留可引用来源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 [Tavily](https://tavily.com) 搜索 web，获得带 snippet 与发布日期的可引用来源。当部署持有 Tavily API 密钥、并希望每次搜索时解析该密钥而不是在注册时捕获时选择它。Tavily 还会返回生成答案；本提供方会丢弃它，因此结果不携带 `content`——只产出模型可引用的来源。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

已交付的 `dsh-base` 组合不挂载本包。要用 Tavily 替换 DeepSeek 搜索的 profile 应插入此行，并在 `web` 行上设置 `searchProvider: tavily`。

### 何时选择

当部署持有 Tavily API 密钥，并希望每次搜索都通过可选的 `ctx.credentials` seam 解析密钥、让轮换后的凭据无需重新挂载即可作用于下一次调用时，选择此后端。没有任何层提供密钥时，调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；端点基址无法解析时，提供方不可用。

### 最小配置

加载 web 服务与本提供方；凭据引用默认为 `TAVILY_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Tavily API 密钥。优先使用 `apiKeyEnv`，避免密钥进入配置；非空字面量优先生效 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；未挂载该 seam 时从启动环境读取 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic` 或 `advanced` |
| `maxResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)是每个受支持字段及其 JSDoc 的穷尽式真源。

每个字段都是 volatile：对当前 profile 的 `cordis.patch.yml` 中此条目的修改（包括通过设置表单所做的修改）会作用于下一次搜索，无需重新挂载插件，因为提供方每次调用都读取当前值。`apiKey` 带有 `role('secret')`，因此设置表单不会返回它的值。

### 搜索返回什么

每项 Tavily 结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`、`publishedAt` ← `published_date`。没有可用 URL 的结果会被丢弃；有 URL 但没有 snippet 的结果会保留。结果按 URL 去重。请求的 `maxResults` 优先于已配置的默认值，并作为 Tavily `max_results` 发送；服务仍在返回时强制执行上限。Tavily 的生成答案会被丢弃，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现；没有任何层提供的密钥以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Tavily API 之上的薄适配器，遵循两条刻意的规则：

- **只保留可引用来源。** Tavily 的生成答案是提供方文本，而不是模型可以归因的来源，因此会被丢弃，而不是填入 seam 的可选 `content`。
- **按次解析凭据。** 密钥在每次搜索时解析，而不是在注册时捕获，因此轮换或之后才存储的凭据无需重新挂载插件即可作用于下一次调用。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：volatile 配置 schema、凭据与环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchResponse`、`TavilyResult`、`TavilySearchDepth` |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询、检索深度与可选结果数 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。存在 `ctx.credentials` seam 时密钥来自它，否则来自启动环境；字面量 `apiKey` 会跳过这两者。解析后的 `results[]` 逐项映射，没有 URL 的条目被丢弃并去除重复项，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`，或进入时已经中止的调用方信号——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——提供方家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、snippet 与发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily search credential resolution failed: <error>`、`Tavily search has no API key for "<ref>"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config` 和 `Tavily returned an unprocessable response body: <error>`；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **Tavily 的生成答案会被丢弃**——它不是可引用的来源，因此 seam 的可选 `content` 保持为空。
- **只公开 `searchDepth` 与 `maxResults`**——Tavily 的其他控制项（topic、时间范围、域名过滤条件、extract）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 或已经中止的调用方信号才映射为 `WEB_ABORTED`；`fetch` 期间携带自定义原因的中止可能呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Tavily 控制面

Tavily 的 topic、时间范围、域名过滤条件与 extract 端点仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
