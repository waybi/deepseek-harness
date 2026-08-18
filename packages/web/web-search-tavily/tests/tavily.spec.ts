import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'

const searchProvider = (options: TavilySearchProviderOptions): TavilySearchProvider =>
  new TavilySearchProvider(() => options)

const options: TavilySearchProviderOptions = {
  apiKey: 'tvly-key',
  baseURL: 'https://api.tavily.test',
  searchDepth: 'basic',
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: 'salient sentence',
      published_date: '2026-01-01',
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'salient sentence',
      publishedAt: '2026-01-01',
    })
  })

  it('keeps a result with no snippet', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: 'A' }))
      .toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('drops a result with no usable URL', () => {
    expect(mapTavilyResult({ title: 'A', content: 'hi' })).toBeUndefined()
    expect(mapTavilyResult({ url: '' })).toBeUndefined()
    expect(mapTavilyResult({ url: '  ' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: null, content: null, published_date: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', title: '', content: '  ', published_date: '' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response, drops empty URLs, and dedupes by URL', () => {
    const result = mapTavilyResponse({
      results: [
        { url: 'https://a.test', content: 'one' },
        { url: '' },
        { url: 'https://a.test', title: 'second' },
        { url: 'https://c.test', title: 'C', content: 'three' },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({}).sources).toEqual([])
  })
})

describe('TavilySearchProvider availability', () => {
  it('is unavailable without a key or resolver', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is available with a resolver and no literal key', () => {
    expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: async () => 'later',
    }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxResults is set but not a positive integer', () => {
    expect(searchProvider({ ...options, maxResults: -1 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxResults: 1.5 }).available()).toBe(false)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends query, search_depth, include_answer false, max_results and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await searchProvider({ ...options, searchDepth: 'advanced' }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tvly-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      search_depth: 'advanced',
      include_answer: false,
      max_results: 5,
    })
  })

  it('falls back to the configured maxResults when a request omits it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, maxResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 7 })
  })

  it('lets a request maxResults win over the configured default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, maxResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 2 })
  })

  it('omits max_results when neither the request nor config names one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('max_results')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('TavilySearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    const before: TavilySearchProviderOptions = { ...options, apiKey: '', baseURL: 'https://before.test', searchDepth: 'basic' }
    const after: TavilySearchProviderOptions = { ...options, apiKey: '', baseURL: 'https://after.test', searchDepth: 'advanced' }
    let current: TavilySearchProviderOptions = before
    let commitSettings = (): void => {}
    const resolveApiKey = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('key-from-before') }
    })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new TavilySearchProvider(() => ({ ...current, resolveApiKey }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(endpoint).toBe('https://before.test/search')
    expect(init.headers['authorization']).toBe('Bearer key-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ search_depth: 'basic' })
  })
})

describe('TavilySearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey,
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the default credential reference when no resolver is configured', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Tavily search has no API key for "TAVILY_API_KEY"')
  })

  it('maps a credential resolver rejection to WEB_PROVIDER_ERROR', async () => {
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Tavily search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tavilyPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(tavilyPlugin)
    expect(unwrapped.name).toBe('web-search-tavily')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('threads searchDepth and maxResults config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key', searchDepth: 'advanced', maxResults: 9 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ search_depth: 'advanced', max_results: 9 })
    await fiber.dispose()
  })

  it('falls back to $TAVILY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      tavilyPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.tavily.com/search')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-tavily-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(tavilyPlugin, { baseURL: 'https://api.tavily.test' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('TAVILY_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['authorization'])).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })

  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.TAVILY_API_KEY = prev
    }
  })
})
