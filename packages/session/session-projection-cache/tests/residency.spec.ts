/**
 * Bounded residency of the projection cache: startup reads only the newest
 * records inside the configured window, other records load on demand
 * (`ensureLoaded`, `loadListing`), clean records leave memory in
 * least-recently-used order, and records of live sessions or with a pending
 * write stay. Every expected key set below is computed from the fixture's
 * construction rules, never from the selection function under test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, {
  SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import { PerRecordJsonUnit } from '@deepseek-ai/dsh-storage-json/src/per-record-unit.ts'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache, { Config } from '../src/index.ts'
import { selectStartupKeys } from '../src/residency.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'residency-test/note': string
    'residency-test/detail': SessionProjectionSummaryExcluded<string>
    'residency-test/opaque': Record<string, unknown>
    title: string | null
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'residency-test/note': { note: string }
  }
  interface OutOfBandSessionEventMap {
    'residency-test/note': true
  }
}

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = 1_800_000_000_000
const FIXTURE_SIZE = 7001

const noteUnit = {
  key: 'residency-test/note',
  stateSchema: z.string(),
  init: () => '',
  apply: (state, event) => event.type === 'residency-test/note' ? event.data.note : state,
  wire: { viewSchema: z.string(), view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'residency-test/note', string>

/** Hidden from summaries: a listing view must not answer for it. */
const detailUnit = {
  key: 'residency-test/detail',
  stateSchema: z.string(),
  init: () => '',
  apply: state => state,
  wire: { viewSchema: z.string(), view: state => state, summary: false },
  stateVersion: 1,
} satisfies ProjectionDefinition<'residency-test/detail', string>

/**
 * A unit whose state is an opaque JSON object: it stands in for the
 * model-window, reasoning-effort, provider, and message payloads other units
 * store, so the cache's own read paths can be judged for passing them
 * through unchanged.
 */
const opaqueUnit = {
  key: 'residency-test/opaque',
  stateSchema: z.record(z.string(), z.unknown()),
  init: () => ({}),
  apply: state => state,
  wire: { viewSchema: z.record(z.string(), z.unknown()), view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'residency-test/opaque', Record<string, unknown>>

const titleUnit = {
  key: 'title',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: state => state,
  wire: { viewSchema: z.string().nullable(), view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'title', string | null>

const idOf = (ordinal: number): SessionId => SessionId(`res-${String(ordinal).padStart(5, '0')}`)
const headerOf = (ordinal: number): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: idOf(ordinal), createdAt: ordinal, isSeeded: false })
/** Fixture rule: record `ordinal` was last written `ordinal` hours before NOW. */
const mtimeOf = (ordinal: number): number => NOW - ordinal * HOUR

function recordOf(ordinal: number): CheckpointRecord {
  return {
    identity: { formatVersion: SESSION_FORMAT_VERSION, createdAt: ordinal, isSeeded: false, inheritedEventCount: SessionLogOffset(0) },
    rows: {
      'title': { ver: 1, seq: SessionSeq(1), val: `Title ${ordinal}` },
      'residency-test/note': { ver: 1, seq: SessionSeq(1), val: `note ${ordinal}` },
      'residency-test/detail': { ver: 1, seq: SessionSeq(1), val: `detail ${ordinal}` },
    },
  }
}

const recordPath = (root: string, id: string): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`)

async function writeDocument(root: string, ordinal: number, text?: string): Promise<void> {
  const path = recordPath(root, idOf(ordinal))
  await writeFile(path, text ?? JSON.stringify({ version: projectionCacheDomainSpec.version, record: recordOf(ordinal) }))
  await utimes(path, new Date(mtimeOf(ordinal)), new Date(mtimeOf(ordinal)))
}

async function fixtureRoot(count: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-residency-'))
  await mkdir(join(root, projectionCacheDomainSpec.name, 'sessions'), { recursive: true })
  for (let start = 0; start < count; start += 500) {
    await Promise.all(Array.from({ length: Math.min(500, count - start) }, (_, index) => writeDocument(root, start + index)))
  }
  return root
}

const contexts: Context[] = []
const roots: string[] = []
let shared: string

beforeAll(async () => {
  shared = await fixtureRoot(FIXTURE_SIZE)
}, 120_000)

afterAll(async () => {
  await rm(shared, { recursive: true, force: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(root: string, startupMaxAgeDays: number, maxResidentRecords: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.sessionProjections.register(titleUnit)
  await ctx.sessionProjections.register(noteUnit)
  await ctx.sessionProjections.register(detailUnit)
  await ctx.sessionProjections.register(opaqueUnit)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays, maxResidentRecords })
  const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
  return { ctx, cache: ctx.sessionProjectionCache, residentKeys: () => new Set([...table.keys()]), residentCount: () => table.size }
}

/** Ordinals `[from, to)` as session ids. */
const ids = (from: number, to: number): Set<string> => new Set(Array.from({ length: to - from }, (_, index) => idOf(from + index)))

describe('startup selection', () => {
  const stamp = (key: string, modifiedAt: number) => ({ key, modifiedAt })

  it.each([
    ['empty', [], 30, 3, []],
    ['one record', [stamp('a', NOW)], 30, 3, ['a']],
    ['exactly the cap', [stamp('a', NOW - 1), stamp('b', NOW - 2), stamp('c', NOW - 3)], 30, 3, ['a', 'b', 'c']],
    ['one over the cap keeps the newest', [stamp('a', NOW - 1), stamp('b', NOW - 2), stamp('c', NOW - 3), stamp('d', NOW - 4)], 30, 3, ['a', 'b', 'c']],
    ['window start is inclusive, one ms earlier is out', [stamp('in', NOW - 30 * DAY), stamp('out', NOW - 30 * DAY - 1)], 30, 3, ['in']],
    ['equal times order by key and stay within the cap', [stamp('c', NOW), stamp('a', NOW), stamp('b', NOW)], 30, 2, ['a', 'b']],
    ['a record written after startup began counts as newest', [stamp('old', NOW - DAY), stamp('new', NOW + 5)], 30, 1, ['new']],
    ['a very large legal cap keeps the whole window', [stamp('a', NOW), stamp('b', NOW - 40 * DAY)], 30, Number.MAX_SAFE_INTEGER, ['a']],
  ])('%s', (_name, stamps, days, cap, expected) => {
    expect(selectStartupKeys(stamps, NOW, days, cap)).toEqual(expected)
  })

  it('rejects missing and illegal bounds at config validation', () => {
    const base = { writeEveryEvents: 1, writeIntervalMs: 1 }
    expect(Config({ ...base, startupMaxAgeDays: 30, maxResidentRecords: 300 }))
      .toMatchObject({ startupMaxAgeDays: 30, maxResidentRecords: 300 })
    for (const bad of [0, -1, 1.5, '30', undefined]) {
      expect(() => Config({ ...base, startupMaxAgeDays: bad, maxResidentRecords: 300 } as never)).toThrow()
      expect(() => Config({ ...base, startupMaxAgeDays: 30, maxResidentRecords: bad } as never)).toThrow()
    }
  })
})

describe('bounded startup over 7001 stored records', () => {
  it('loads only the newest records inside the window, reading no other record', async () => {
    const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
    const loadAll = vi.spyOn(PerRecordJsonUnit.prototype, 'loadAll')
    const { residentKeys } = await harness(shared, 30, 300)
    // Window: ordinals 0..720 (720 h = 30 days, inclusive); cap 300 → ordinals 0..299.
    expect(residentKeys()).toEqual(ids(0, 300))
    expect(reads).toHaveBeenCalledTimes(300)
    expect(new Set(reads.mock.calls.map(([, key]) => key))).toEqual(ids(0, 300))
    expect(loadAll).not.toHaveBeenCalled()
  })

  it('loads the smaller set when the day window is tighter than the cap', async () => {
    const { residentKeys } = await harness(shared, 1, 300)
    // 24 h inclusive → ordinals 0..24.
    expect(residentKeys()).toEqual(ids(0, 25))
  })

  it('loads nothing from an empty medium', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-residency-empty-'))
    roots.push(root)
    const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
    const { residentKeys } = await harness(root, 30, 300)
    expect(residentKeys().size).toBe(0)
    expect(reads).not.toHaveBeenCalled()
  })
})

describe('on-demand reads of records outside the startup set', () => {
  const events = (note: string): SessionEvent[] => [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    { type: 'residency-test/note', seq: SessionSeq(1), time: 1, data: { note } },
    { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  it('serves a cold record after ensureLoaded and seeds the prepared fold from it', async () => {
    const { cache, residentKeys } = await harness(shared, 30, 300)
    const meta = headerOf(5000)
    expect(cache.cachedSnapshot(meta)).toBeUndefined()
    await expect(cache.ensureLoaded(meta.id)).resolves.toBe(true)
    expect(cache.cachedSnapshot(meta)).toEqual({
      asOfSeq: 1,
      values: { 'title': 'Title 5000', 'residency-test/note': 'note 5000', 'residency-test/detail': 'detail 5000' },
    })
    // The seeded row wins over the log's own (seq 1) note: the record, not a replay, served it.
    const session = Session.create(meta.id, events('from the log'), meta)
    expect(cache.hydratePrepared(session, events('from the log')).values['residency-test/note']).toBe('note 5000')
    // The bound held: the least recently used startup record (ordinal 299) left memory.
    expect(residentKeys().size).toBe(300)
    expect(residentKeys().has(idOf(299))).toBe(false)
    expect(residentKeys().has(meta.id)).toBe(true)
  })

  it('keeps only a listing view of a record read for the list', async () => {
    const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
    const { ctx, cache, residentKeys } = await harness(shared, 30, 300)
    reads.mockClear()
    const meta = headerOf(6000)
    const summary = await cache.loadListing(meta)
    expect(summary).toEqual({ asOfSeq: 1, values: { 'title': 'Title 6000', 'residency-test/note': 'note 6000' } })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(residentKeys().has(meta.id)).toBe(false)
    expect(residentKeys().size).toBe(300)
    // The listing view answers summary-key readers synchronously, never a full read.
    expect(cache.cachedSnapshot(meta, ctx.sessionProjections.summaryKeys())).toEqual(summary)
    expect(cache.cachedSnapshot(meta, ['title'])).toEqual({ asOfSeq: 1, values: { title: 'Title 6000' } })
    expect(cache.cachedSnapshot(meta)).toBeUndefined()
    expect(cache.cachedSnapshot(meta, ['residency-test/detail'])).toBeUndefined()
    // A second listing is served from the view without another read.
    await expect(cache.loadListing(meta)).resolves.toEqual(summary)
    expect(reads).toHaveBeenCalledTimes(1)
    // Another lifecycle under the same id is not served from the view.
    expect(cache.cachedSnapshot({ ...meta, createdAt: 99 }, ['title'])).toBeUndefined()
  })

  it('passes opaque model, message, and empty values through startup, on-demand, and listing views', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-opaque-'))
    roots.push(root)
    await mkdir(join(root, projectionCacheDomainSpec.name, 'sessions'), { recursive: true })
    // Values shaped like the model-window, reasoning, provider, tool, and message
    // payloads other units store; the cache must not interpret or reshape them.
    const opaque = {
      model: {
        provider: 'anthropic', model: 'opus', contextWindow: 1_000_000, maxTokens: 64_000,
        reasoningEffort: 'xhigh', forceAdaptiveThinking: true,
      },
      providerIds: ['anthropic-pool', 'runai-responses', 'deepseek-web'],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '空回复与仅思考' }] },
        { role: 'assistant', content: [], thinking: '', toolCalls: [{ name: 'bash', arguments: {} }] },
      ],
      nothing: null,
      empty: '',
      enormous: '工'.repeat(174_762),
    }
    const recent = { ...headerOf(0), id: SessionId('opaque-recent') }
    const cold = { ...headerOf(1), id: SessionId('opaque-cold') }
    for (const [meta, ageHours] of [[recent, 0], [cold, 90 * 24]] as const) {
      const document = {
        version: projectionCacheDomainSpec.version,
        record: {
          identity: { formatVersion: meta.version, createdAt: meta.createdAt, isSeeded: false, inheritedEventCount: SessionLogOffset(0) },
          rows: { 'residency-test/opaque': { ver: 1, seq: SessionSeq(0), val: opaque } },
        },
      }
      const path = recordPath(root, meta.id)
      await writeFile(path, JSON.stringify(document))
      const when = new Date(NOW - ageHours * HOUR)
      await utimes(path, when, when)
    }
    const { ctx, cache, residentKeys } = await harness(root, 30, 1)
    expect(residentKeys()).toEqual(new Set([recent.id]))
    expect(cache.cachedSnapshot(recent, ['residency-test/opaque'])).toEqual({ asOfSeq: 0, values: { 'residency-test/opaque': opaque } })
    await expect(cache.ensureLoaded(cold.id)).resolves.toBe(true)
    expect(cache.cachedSnapshot(cold, ['residency-test/opaque'])).toEqual({ asOfSeq: 0, values: { 'residency-test/opaque': opaque } })
    // The on-demand read displaced the recent complete record into a listing
    // view; that view still serves every stored value unchanged.
    expect(residentKeys().size).toBe(1)
    await expect(cache.loadListing(recent)).resolves.toEqual({ asOfSeq: 0, values: { 'residency-test/opaque': opaque } })
    expect(cache.cachedSnapshot(recent, ctx.sessionProjections.summaryKeys())?.values['residency-test/opaque']).toEqual(opaque)
  })

  it('lists every one of 7001 records while complete residents stay within the bound', async () => {
    const { ctx, cache, residentKeys, residentCount } = await harness(shared, 30, 300)
    const keys = ctx.sessionProjections.summaryKeys()
    const wrong: number[] = []
    let maxResident = 0
    for (let ordinal = 0; ordinal < FIXTURE_SIZE; ordinal++) {
      const meta = headerOf(ordinal)
      const served = cache.cachedSnapshot(meta, keys) ?? await cache.loadListing(meta)
      if (served?.values.title !== `Title ${ordinal}`) wrong.push(ordinal)
      maxResident = Math.max(maxResident, residentCount())
    }
    expect(wrong).toEqual([])
    expect(maxResident).toBeLessThanOrEqual(300)
    // Startup residents never left: listing reads do not displace them.
    expect(residentKeys()).toEqual(ids(0, 300))
  }, 60_000)
})

/** Block the next record write until `release` runs; later writes pass through. */
function gateNextPut(): { release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const real = Object.getOwnPropertyDescriptor(PerRecordJsonUnit.prototype, 'putRecord')?.value as PerRecordJsonUnit['putRecord']
  vi.spyOn(PerRecordJsonUnit.prototype, 'putRecord').mockImplementationOnce(async function (this: PerRecordJsonUnit, table, key, value) {
    await gate
    return real.call(this, table, key, value)
  })
  return { release }
}

describe('residency under writes and failures', () => {
  it('never evicts a live session\'s record or one with a pending write', async () => {
    const root = await fixtureRoot(6)
    roots.push(root)
    const { ctx, cache, residentKeys } = await harness(root, 30, 2)
    expect(residentKeys()).toEqual(ids(0, 2))
    // A live session over a stored record outside the startup set.
    ctx.sessions.create(idOf(5), { meta: headerOf(5) })
    await vi.waitFor(() => { expect(residentKeys().has(idOf(5))).toBe(true) })
    for (const ordinal of [2, 3, 4]) await cache.ensureLoaded(idOf(ordinal))
    // The live record stays although it is the least recently used; clean records yield.
    expect(residentKeys()).toEqual(new Set([idOf(5), idOf(4)]))

  })

  it('keeps a record whose write is still queued when another write overflows the bound', async () => {
    const root = await fixtureRoot(6)
    roots.push(root)
    const { cache, residentKeys } = await harness(root, 30, 2)
    await cache.ensureLoaded(idOf(4))
    // Make 4 the least recently used resident record.
    cache.cachedSnapshot(headerOf(0))
    expect(residentKeys()).toEqual(new Set([idOf(0), idOf(4)]))
    const sessionOf = (ordinal: number): Session => {
      const session = Session.create(idOf(ordinal), [], headerOf(ordinal))
      session.append('residency-test/note', { note: `written ${ordinal}` })
      return session
    }
    const first = gateNextPut()
    const second = gateNextPut()
    const writing3 = cache.write(sessionOf(3))
    const writing4 = cache.write(sessionOf(4))
    first.release()
    await writing3
    // 3 landed and overflowed the bound: 4 is the oldest but its write is queued, so 0 left instead.
    expect(residentKeys()).toEqual(new Set([idOf(3), idOf(4)]))
    second.release()
    await writing4
    expect(cache.cachedSnapshot(headerOf(4), ['residency-test/note'])?.values['residency-test/note']).toBe('written 4')
    expect(residentKeys().size).toBe(2)
  })

  it('orders an on-demand read behind a pending write and recovers after a failed one', async () => {
    const root = await fixtureRoot(3)
    roots.push(root)
    const { cache, residentKeys } = await harness(root, 30, 1)
    const meta = headerOf(2)
    const session = Session.create(meta.id, [], meta)
    session.append('residency-test/note', { note: 'v1' })
    await cache.write(session)
    // The startup record (ordinal 0) yielded to the newer write; evict 2 again by reading 1.
    await cache.ensureLoaded(idOf(1))
    expect(residentKeys()).toEqual(new Set([idOf(1)]))

    const { release } = gateNextPut()
    session.append('residency-test/note', { note: 'v2' })
    const writing = cache.write(session)
    let loaded = false
    const load = cache.ensureLoaded(meta.id).then(() => { loaded = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(loaded).toBe(false)
    release()
    await writing
    await load
    expect(cache.cachedSnapshot(meta, ['residency-test/note'])?.values['residency-test/note']).toBe('v2')

    // A failed write is reported, and memory keeps what the medium holds.
    vi.spyOn(PerRecordJsonUnit.prototype, 'putRecord').mockRejectedValueOnce(new Error('disk full'))
    session.append('residency-test/note', { note: 'v3' })
    await expect(cache.write(session)).rejects.toThrow('disk full')
    expect(cache.cachedSnapshot(meta, ['residency-test/note'])?.values['residency-test/note']).toBe('v2')
    await cache.ensureLoaded(idOf(1))
    await cache.ensureLoaded(meta.id)
    expect(cache.cachedSnapshot(meta, ['residency-test/note'])?.values['residency-test/note']).toBe('v2')
    session.append('residency-test/note', { note: 'v4' })
    await cache.write(session)
    expect(cache.cachedSnapshot(meta, ['residency-test/note'])?.values['residency-test/note']).toBe('v4')
  })

  it('serves a missing, unreadable, corrupt, or version-mismatched cold record as uncached without throwing', async () => {
    const root = await fixtureRoot(4)
    roots.push(root)
    await writeDocument(root, 2, '{"version":7,"record":{"identity":')
    await writeDocument(root, 3, JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: recordOf(3).identity, rows: { title: { ver: 99, seq: 1, val: 'stale' } } } }))
    const { ctx, cache } = await harness(root, 30, 1)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await expect(cache.ensureLoaded(idOf(40))).resolves.toBe(false)
    await expect(cache.loadListing(headerOf(2))).resolves.toBeUndefined()
    await expect(cache.loadListing(headerOf(3))).resolves.toBeUndefined()
    vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord').mockRejectedValue(new Error('EIO'))
    await expect(cache.ensureLoaded(idOf(1))).resolves.toBe(false)
    await expect(cache.loadListing(headerOf(1))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toContain('EIO')
    // Uncached: the fold replays the exact log.
    const meta = headerOf(1)
    const log: SessionEvent[] = [{ type: 'residency-test/note', seq: SessionSeq(0), time: 0, data: { note: 'log' } }]
    expect(cache.hydratePrepared(Session.create(meta.id, log, meta), log).values['residency-test/note']).toBe('log')
  })
})
