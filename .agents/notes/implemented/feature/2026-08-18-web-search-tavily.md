# Agent Note: Tavily search provider for the web seam

Status: implemented

English | [中文](2026-08-18-web-search-tavily.zh.md)

## Problem

Shipped compositions pin `web_search` to DeepSeek's native Anthropic-compatible Messages tool. That path needs `DEEPSEEK_API_KEY` and a backend that returns `web_search_tool_result`. Deployments that already pay for conversation through a local OpenAI/Anthropic gateway, and that already hold a Tavily key for retrieval, cannot use `web_search` without buying a second DeepSeek Messages call. Pointing `web-search-deepseek`'s `baseURL` at the conversation gateway fails: the gateway answers with ordinary `tool_use`, not native search result blocks.

## Decision

`@deepseek-ai/dsh-web-search-tavily` is a fourth search Service Provider on `ctx.web`. It registers id `tavily`, calls `POST {baseURL}/search` with `search_depth` and `include_answer: false`, and maps `results[]` to `WebSearchSource` (`url`, `title`, `snippet` ← `content`, `publishedAt` ← `published_date`). Generated answers are discarded. The model-facing `web_search` schema stays on `dsh-tool-web`.

Credentials follow the DeepSeek search path, not Exa: each search snapshots the settings section, then resolves `apiKeyEnv` (default `TAVILY_API_KEY`) through `ctx.credentials`, or the launching environment when that seam is absent. A non-empty literal `apiKey` wins. `available()` treats an installed resolver as locally usable; a missing key fails the operation as `WEB_PROVIDER_CREDENTIAL_MISSING` while the tool schema stays registered.

`dsh-base` still pins `searchProvider: deepseek-official` and still mounts only `dsh-web-search-deepseek`. A profile that wants Tavily inserts this package and sets `searchProvider: tavily` on the `web` row. The shipped one-minute DeepSeek search timeout is not inherited; Tavily uses `dsh-tool-web`'s provider-neutral 30-second default unless the overlay restates it.

## Alternatives considered

**Point `web-search-deepseek` at the conversation gateway.** Rejected because that provider requires native `web_search_20250305` result blocks. A gateway that speaks ordinary Anthropic Messages returns `tool_use` and fails the provider's strict mapping.

**Teach the conversation gateway to impersonate DeepSeek native search.** Rejected because each search would still cost a full model turn, and the protocol would belong to the wrong owner.

**Select the search backend from the conversation model name, as cc-haha's `auto` mode does.** Rejected because `ctx.web` already owns selection through a configured provider id. Model-name heuristics and native-to-Tavily fallback would make one search's protocol and cost depend on runtime failure.

**Fold Tavily into `dsh-tool-web`.** Rejected because providers register capabilities, not tools. A vendor swap must not change the model schema.

**Mount Tavily in `dsh-base` or change the shipped `searchProvider`.** Rejected because the product default remains DeepSeek native search. A local retrieval key is a profile overlay, not a new shipped default.

**Open `web_fetch` in the same change.** Rejected because search is discovery; default fetch would let the model retrieve arbitrary URLs. Tavily extract stays out of this provider.

## Consequences

Deployments with a Tavily key can pin `searchProvider: tavily` and keep conversation on an unrelated LLM route. Each `web_search` is one retrieval HTTP call, not an auxiliary model turn. The shipped DeepSeek default, its 60-second budget, and its session-log request event are unchanged. There is no Plugins settings card and no `apiproxy` allowlist entry for `web-search-tavily`; a stored section still applies through the settings document. Provider tests pin mapping, request bodies, abort and HTTP failures, per-search credential rotation, and settings-section projection.
