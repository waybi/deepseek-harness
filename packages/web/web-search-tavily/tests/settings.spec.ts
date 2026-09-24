/** The `web-search-tavily` volatile config layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The smallest Tavily answer the provider accepts — enough to observe the request. */
const ONE_RESULT = {
  query: 'anything',
  results: [{ url: 'https://a.test', title: 'A', content: 'a' }],
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const live = await liveConfig(ctx, tavilyPlugin, { apiKey: 'tvly-key', baseURL: 'https://search.entry.test' })
  return { ctx, live }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and capture the request the provider sent. A fresh `Response`
 * per call because a body can only be read once, and the call history is
 * cleared because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the fetched URL and the parsed JSON request body.
 */
async function searchOnce(ctx: Context): Promise<{ url: string; body: Record<string, unknown> }> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  const [input, init] = fetchSpy.mock.calls.at(-1) ?? []
  const rawBody = (init as RequestInit | undefined)?.body
  return {
    url: String((input as URL | string | undefined) ?? ''),
    body: typeof rawBody === 'string' ? JSON.parse(rawBody) as Record<string, unknown> : {},
  }
}

describe('web-search-tavily volatile config', () => {
  it('serves an updated endpoint and depth to the next search without re-registering the provider', async () => {
    const bench = await boot()
    const first = await searchOnce(bench.ctx)
    expect(first.url).toContain('https://search.entry.test')
    expect(first.body.search_depth).toBe('basic')

    await bench.live.update({ baseURL: 'https://search.stored.test', searchDepth: 'advanced' })

    const second = await searchOnce(bench.ctx)
    expect(second.url).toContain('https://search.stored.test')
    expect(second.body.search_depth).toBe('advanced')
    await bench.ctx.fiber.dispose()
  })
})
