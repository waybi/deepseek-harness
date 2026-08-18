# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Tavily's `POST /search` retrieval endpoint and maps the flat `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, resolves its credential for each search through the optional `ctx.credentials` seam, and does not register a model-facing tool. Like `@deepseek-ai/dsh-web-search-deepseek`, it is a function/namespace plugin (`inject: ['web']`).

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Tavily API key. Prefer `apiKeyEnv` so no secret enters configuration; a non-empty literal wins. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that seam is absent. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily `search_depth`: `basic` or `advanced`. |
| `maxResults` | omitted | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

The entry above is the base layer of the `web-search-tavily` Settings section: a user layer over it reaches the NEXT search, because the provider projects the section per call rather than capturing it at registration. `apiKey` carries `role('secret')`, so it never rides a `describe()` response in any layer.

This package is not mounted by the shipped `dsh-base` composition. A profile that wants Tavily instead of DeepSeek search inserts this row and sets `searchProvider: tavily` on the `web` row.

## Mapping

Tavily returns a flat `results[]` and an optional generated answer; the answer is discarded, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `published_date`. A result with no usable URL is dropped; a result with a URL but no snippet is kept. Results are deduplicated by URL. A request's `maxResults` wins over the configured default and is sent as Tavily `max_results`; the seam still enforces the bound on return.

Provider failures become `WEB_PROVIDER_ERROR`; caller cancellation becomes `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Missing credentials fail as `WEB_PROVIDER_CREDENTIAL_MISSING`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, `Tavily search credential resolution failed: <error>`, `Tavily search has no API key for "<ref>"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Tavily's generated answer is discarded** — it is not a citeable source, so the seam's optional `content` stays empty.
- **Only `searchDepth` and `maxResults` are exposed** — Tavily's other controls (topic, time range, domain filters, extract) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` or an already-aborted caller signal maps to `WEB_ABORTED`; an abort carrying a custom reason during `fetch` itself may surface as `WEB_PROVIDER_ERROR`.
