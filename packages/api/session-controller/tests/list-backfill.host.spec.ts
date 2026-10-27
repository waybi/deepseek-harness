/**
 * Background cache backfill of cold Session-list rows: a row the projection
 * cache has not served is folded from its log after `list()` returns, then
 * republished with its blank bit and title.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { ApiSessionList } from '../src/list.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

const evt = (type: string, seq: number, data: unknown): SessionEvent =>
  ({ type, seq: SessionSeq(seq), time: 1000 + seq, data }) as SessionEvent

const initEvents = (): SessionEvent[] => [evt('plan/mode', 0, { active: true })]
const titledEvents = (title: string): SessionEvent[] => [
  evt('plan/mode', 0, { active: true }),
  evt('session/title', 1, { title, messageSeqs: [], source: { kind: 'user' } }),
]

interface Options {
  readonly maxLogBytes?: number
  readonly concurrency?: number
}

async function harness(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-list-backfill-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'cache') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  installSessionReadTestServices(ctx)
  const added: SessionSummary[] = []
  const list = new ApiSessionList(ctx, 8, {
    maxLogBytes: options.maxLogBytes ?? 1_000_000,
    concurrency: options.concurrency ?? 2,
    onBackfilled: (summary) => { added.push(summary) },
  })
  const store = async (id: string, events: SessionEvent[]): Promise<SessionHeader> => {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 10, isSeeded: false, cwd: '/proj',
    }
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(events)
    await handle.flush()
    await handle.close()
    return header
  }
  return { ctx, list, added, store, cache: ctx.sessionProjectionCache }
}

async function rowOf(list: ApiSessionList, id: string): Promise<SessionSummary> {
  const row = (await list.list()).find(item => item.sessionId === id)
  if (row === undefined) throw new Error(`row ${id} missing`)
  return row
}

describe('cold list backfill', () => {
  it('AC1: an init-only log is blank=false at first, then cached blank=true and published once', async () => {
    const { list, added, store, cache } = await harness()
    const header = await store('empty', initEvents())
    expect((await rowOf(list, 'empty')).blank).toBe(false)
    await vi.waitFor(() => { expect(cache.cachedSnapshot(header)).toBeDefined() })
    expect(cache.cachedSnapshot(header)?.values.sessionListMetadata?.blank).toBe(true)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ sessionId: 'empty', blank: true, agentAvailable: false })
    const second = await rowOf(list, 'empty')
    expect(second.blank).toBe(true)
    expect(await rowOf(list, 'empty')).toEqual(second)
    expect(added).toHaveLength(1)
  })

  it('AC2: a titled log lists its title and blank=true after backfill', async () => {
    const { list, added, store } = await harness()
    await store('titled', titledEvents('日常聊天'))
    await rowOf(list, 'titled')
    await vi.waitFor(() => { expect(added).toHaveLength(1) })
    await vi.waitFor(async () => {
      expect((await rowOf(list, 'titled')).projections?.values.title).toBe('日常聊天')
    })
    const row = await rowOf(list, 'titled')
    expect(row.blank).toBe(true)
    expect(added[0]?.projections?.values.title).toBe('日常聊天')
  })

  it('AC2: a log with a turn stays visible (blank=false) with its title', async () => {
    const { list, added, store } = await harness()
    await store('started', [...titledEvents('Nomi'), evt('turn/start', 2, { turn: 1 })])
    await rowOf(list, 'started')
    await vi.waitFor(() => { expect(added).toHaveLength(1) })
    expect(added[0]).toMatchObject({ blank: false })
    expect(added[0]?.projections?.values.title).toBe('Nomi')
  })

  it('AC3: a log above the byte limit is not read; a log exactly at the limit is', async () => {
    const probe = await harness()
    const header = await probe.store('probe', initEvents())
    const size = (await probe.ctx.sessionPersistence.stat(header.id))?.sizeBytes
    if (size === undefined) throw new Error('jsonl persistence reports sizeBytes')

    const over = await harness({ maxLogBytes: size - 1 })
    const overHeader = await over.store('probe', initEvents())
    const open = vi.spyOn(over.ctx.sessionPersistence, 'open')
    const stat = vi.spyOn(over.ctx.sessionPersistence, 'stat')
    const row = await rowOf(over.list, 'probe')
    await vi.waitFor(() => { expect(stat).toHaveBeenCalledTimes(1) })
    await stat.mock.results[0]?.value
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(open).not.toHaveBeenCalled()
    expect(over.cache.cachedSnapshot(overHeader)).toBeUndefined()
    expect(over.added).toHaveLength(0)
    expect(row.blank).toBe(false)
    expect(row.projections).toBeUndefined()

    const exact = await harness({ maxLogBytes: size })
    await exact.store('probe', initEvents())
    await rowOf(exact.list, 'probe')
    await vi.waitFor(() => { expect(exact.added).toHaveLength(1) })
  })

  it('AC4: list does not wait for backfill and in-flight backfills respect the concurrency limit', async () => {
    const { ctx, list, store } = await harness({ concurrency: 2 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) await store(id, initEvents())
    const open = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(() => new Promise(() => {}))
    const rows = await list.list()
    expect(rows).toHaveLength(5)
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(open).toHaveBeenCalledTimes(2)
    expect((await list.list())).toHaveLength(5)
  })

  it('AC5: the backfilled cache values equal a normal observation of the same log', async () => {
    const { ctx, list, added, store, cache } = await harness()
    const header = await store('same', [...titledEvents('Same'), evt('turn/start', 2, { turn: 1 })])
    using observation = await ctx.sessionQuery.observeSession(header.id)
    const expected = observation.projections?.values
    if (expected === undefined) throw new Error('observation carries projections')
    const coldSnapshot = vi.spyOn(cache, 'coldSnapshot')
    await rowOf(list, 'same')
    await vi.waitFor(() => { expect(added).toHaveLength(1) })
    await vi.waitFor(() => { expect(cache.cachedSnapshot(header)).toBeDefined() })
    expect(coldSnapshot).toHaveBeenCalledTimes(1)
    const cached = cache.cachedSnapshot(header)?.values
    expect(cached?.sessionListMetadata).toEqual(expected.sessionListMetadata)
    expect(cached?.title).toEqual(expected.title)
  })

  it('AC6: a row the cache already serves is not backfilled', async () => {
    const { ctx, list, store, cache, added } = await harness()
    const header = await store('warm', titledEvents('Warm'))
    await using handle = await ctx.sessionPersistence.open(header.id, 'read')
    cache.coldSnapshot(handle.header, handle.inheritedEventCount, (await handle.read()).events)
    await vi.waitFor(() => { expect(cache.cachedSnapshot(header)).toBeDefined() })
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    const row = await rowOf(list, 'warm')
    expect(row.blank).toBe(true)
    expect(row.projections?.values.title).toBe('Warm')
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(stat).not.toHaveBeenCalled()
    expect(added).toHaveLength(0)
  })

  it('AC7: a session is backfilled once and a failure only warns', async () => {
    const { ctx, list, added, store } = await harness()
    await store('bad', initEvents())
    await store('good', initEvents())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const real = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    const open = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      if (id === 'bad') throw new Error('boom')
      return real(id, access, options)
    })
    for (let round = 0; round < 3; round++) expect(await list.list()).toHaveLength(2)
    await vi.waitFor(() => { expect(added).toHaveLength(1) })
    expect(added[0]?.sessionId).toBe('good')
    expect(stat).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('bad')
    await list.list()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('disposal aborts in-flight backfill and publishes nothing', async () => {
    const { ctx, list, added, store } = await harness()
    await store('late', initEvents())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const real = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
      await gate
      return real(id, options)
    })
    await list.list()
    await vi.waitFor(() => { expect(stat).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    release()
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(added).toHaveLength(0)
  })

  it('the Session Controller emits api-session/added with the backfilled summary', async () => {
    const { ctx, store } = await harness()
    await store('via-controller', initEvents())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })
    const emitted: SessionSummary[] = []
    ctx.on('api-session/added', (summary: SessionSummary) => { emitted.push(summary) })
    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    await vi.waitFor(() => { expect(emitted.filter(item => item.sessionId === 'via-controller')).toHaveLength(1) })
    expect(emitted.find(item => item.sessionId === 'via-controller')).toMatchObject({ blank: true })
  })

  it('a log whose size is unknown is not read', async () => {
    const { ctx, list, added, store } = await harness()
    await store('missing', initEvents())
    await store('unsized', initEvents())
    const real = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
      if (id === 'missing') return undefined
      const snapshot = await real(id, options)
      if (snapshot === undefined) return undefined
      const { sizeBytes: _omitted, ...rest } = snapshot
      return rest
    })
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    await list.list()
    await vi.waitFor(() => { expect(stat).toHaveBeenCalledTimes(2) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(open).not.toHaveBeenCalled()
    expect(added).toHaveLength(0)
  })

  it('a Session that becomes live during the backfill is neither folded nor published', async () => {
    const folded = await harness()
    const header = await folded.store('racing', initEvents())
    const coldSnapshot = vi.spyOn(folded.cache, 'coldSnapshot')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const real = folded.ctx.sessionPersistence.stat.bind(folded.ctx.sessionPersistence)
    vi.spyOn(folded.ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
      await gate
      return real(id, options)
    })
    await folded.list.list()
    vi.spyOn(folded.ctx.sessions, 'get').mockReturnValue({} as never)
    release()
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(coldSnapshot).not.toHaveBeenCalled()
    expect(folded.cache.cachedSnapshot(header)).toBeUndefined()
    expect(folded.added).toHaveLength(0)
  })

  it('a Session that becomes live after the fold is not published', async () => {
    const { ctx, list, added, store, cache } = await harness()
    await store('late-live', initEvents())
    const coldSnapshot = vi.spyOn(cache, 'coldSnapshot')
    let closed = false
    const real = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      const handle = await real(id, access, options)
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); closed = true }
      return handle
    })
    vi.spyOn(ctx.sessions, 'get').mockImplementation(() => (closed ? {} as never : undefined))
    await list.list()
    await vi.waitFor(() => { expect(coldSnapshot).toHaveBeenCalledTimes(1) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(added).toHaveLength(0)
  })
})
