---
description: "The Tavily-backed search provider for ctx.web: how deployments mount credential-resolved web search whose generated answer is discarded in favor of citeable sources."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-tavily`, the harness searches the web through [Tavily](https://tavily.com) and gets citeable sources with snippets and publication dates. Choose it when a deployment holds a Tavily API key and wants that key resolved per search rather than captured at registration. Tavily also returns a generated answer; this provider discards it, so results carry no `content` — only sources the model can cite. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `tavily` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: tavily`.

This package is not mounted by the shipped `dsh-base` composition. A profile that wants Tavily instead of DeepSeek search inserts this row and sets `searchProvider: tavily` on the `web` row.

### When to choose it

Choose this backend when a deployment holds a Tavily API key and wants the key resolved for each search through the optional `ctx.credentials` seam, so a rotated credential reaches the next call without a remount. A call fails with `WEB_PROVIDER_CREDENTIAL_MISSING` when no layer supplies the key, and the provider is unavailable when the endpoint base does not parse.

### Minimal configuration

Load the web service and the provider; the credential reference defaults to `TAVILY_API_KEY`, and every other setting has a safe default.

```yaml
- name: '@deepseek-ai/dsh-web'
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key. Prefer `apiKeyEnv` so no secret enters configuration; a non-empty literal wins |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the launch environment when that seam is absent |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily `search_depth`: `basic` or `advanced` |
| `maxResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-tavily) is the exhaustive source for every accepted field and its JSDoc.

The composition entry above is the base layer of the `web-search-tavily` Settings section: a user layer over it reaches the NEXT search, because the provider projects the section per call rather than capturing it at registration. `apiKey` carries `role('secret')`, so it never rides a `describe()` response in any layer.

### What a search returns

Each Tavily result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `published_date`. A result with no usable URL is dropped; a result with a URL but no snippet is kept. Results are deduplicated by URL. A request's `maxResults` wins over the configured default and is sent as Tavily `max_results`; the service still enforces the bound on return. Tavily's generated answer is discarded, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`; a key no layer supplies surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Tavily's API with two deliberate rules:

- **Citeable sources only.** Tavily's generated answer is provider prose rather than a source the model can attribute, so it is discarded instead of filling the seam's optional `content`.
- **Per-call credential resolution.** The key is resolved for each search instead of captured at registration, so a rotated or later-stored credential reaches the next call without remounting the plugin.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, settings section, credential and environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `TavilySearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Tavily wire types: `TavilySearchResponse`, `TavilyResult`, `TavilySearchDepth` |
| [`src/invariant.ts`](src/invariant.ts) | Runtime invariant companion for the provider's owned registration relation |

### Request and mapping flow

`search()` posts the query, retrieval depth, and optional result count to `{baseURL}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The key comes from `ctx.credentials` when that seam is present and from the launch environment otherwise; a literal `apiKey` short-circuits both. The parsed `results[]` are mapped one by one, URL-less entries dropped and duplicates removed, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError`, or a caller signal already aborted at entry — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the provider family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-tavily) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, `Tavily search credential resolution failed: <error>`, `Tavily search has no API key for "<ref>"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits define when the provider is a poor fit. They are current package constraints.

- **Tavily's generated answer is discarded** — it is not a citeable source, so the seam's optional `content` stays empty.
- **Only `searchDepth` and `maxResults` are exposed** — Tavily's other controls (topic, time range, domain filters, extract) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` or an already-aborted caller signal maps to `WEB_ABORTED`; an abort carrying a custom reason during `fetch` itself may surface as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Tavily control surface

Tavily's topic, time range, domain filters, and extract endpoint stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
