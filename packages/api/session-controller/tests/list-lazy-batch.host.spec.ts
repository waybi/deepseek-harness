/**
 * Fixed-seed batch check over 10001 Sessions with real JSONL logs and a
 * projection cache bounded at the shipped 30 days / 300 records. A manifest
 * generated independently of the cache states each Session's id, log title,
 * user message, and whether its cache record is valid, missing, or corrupt.
 * The judge compares the startup set, a cold open of every Session (title,
 * visible message, record use), and then the Session list (rows, titles, log
 * folds) against that manifest, and checks complete residents stay bounded.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { PerRecordJsonUnit } from '@deepseek-ai/dsh-storage-json/src/per-record-unit.ts'
import { ApiSessionList } from '../src/list.ts'
import type { SessionSummary } from '../src/types.ts'
import { installSessionReadTestServices, TEST_IMAGE_LIMITS } from './test-remote.ts'

const COUNT = 10_001
const WINDOW_DAYS = 30
const CAP = 300

interface Entry {
  readonly header: SessionHeader
  readonly title: string
  readonly message: string
  readonly cache: 'valid' | 'missing' | 'corrupt'
  /** Cache document age in whole hours; some sit exactly on the window start. */
  readonly ageHours: number
}

/** Mulberry32 over a fixed seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function manifest(): Entry[] {
  const next = random(10_001_53)
  return Array.from({ length: COUNT }, (_, index) => {
    const roll = next()
    const ageHours = next() < 0.03 ? WINDOW_DAYS * 24 : Math.floor(next() * 400 * 24)
    return {
      header: { version: SESSION_FORMAT_VERSION, id: SessionId(`b-${String(index).padStart(5, '0')}`), createdAt: 1000 + index, isSeeded: false, cwd: '/proj' },
      title: `标题 ${String(index)} ${'t'.repeat(Math.floor(next() * 30))}`,
      message: `消息 ${String(index)} ${'m'.repeat(Math.floor(next() * 200))}`,
      cache: roll < 0.85 ? 'valid' : roll < 0.95 ? 'missing' : 'corrupt',
      ageHours,
    }
  })
}

/**
 * Requirement stated directly: stored documents changed within 30 days (start inclusive), newest first,
 * ties by id, at most CAP; corrupt ones fail to load.
 */
function expectedStartup(entries: readonly Entry[]): Set<string> {
  const stored = entries.filter(entry => entry.cache !== 'missing' && entry.ageHours <= WINDOW_DAYS * 24)
  stored.sort((left, right) => left.ageHours - right.ageHours || (left.header.id < right.header.id ? -1 : 1))
  return new Set(stored.slice(0, CAP).filter(entry => entry.cache === 'valid').map(entry => entry.header.id))
}

interface Observed {
  readonly startup: ReadonlySet<string>
  /** Listed title per Session id (sync rows overlaid by backfilled rows). */
  readonly listedTitles: ReadonlyMap<string, unknown>
  /** Session ids whose log the list read and folded. */
  readonly listFolds: ReadonlySet<string>
  /** Per Session id: opened title, whether the manifest message is visible, whether the stored record was used. */
  readonly opened: ReadonlyMap<string, { readonly title: unknown; readonly message: boolean; readonly recordUsed: boolean }>
}

/**
 * Compare observations with the manifest.
 * @returns one line per mismatch; empty when they agree.
 */
function judge(entries: readonly Entry[], observed: Observed): string[] {
  const problems: string[] = []
  const expected = expectedStartup(entries)
  for (const id of expected) if (!observed.startup.has(id)) problems.push(`startup missing ${id}`)
  for (const id of observed.startup) if (!expected.has(id)) problems.push(`startup extra ${id}`)
  for (const entry of entries) {
    const id = entry.header.id
    if (!observed.listedTitles.has(id)) problems.push(`list dropped ${id}`)
    else if (observed.listedTitles.get(id) !== entry.title) problems.push(`listed title of ${id}: ${String(observed.listedTitles.get(id))}`)
    if (observed.listFolds.has(id) !== (entry.cache !== 'valid')) problems.push(`list fold of ${id}: ${String(observed.listFolds.has(id))}`)
    const opened = observed.opened.get(id)
    if (opened === undefined) problems.push(`open missing ${id}`)
    else {
      if (opened.title !== entry.title) problems.push(`opened title of ${id}: ${String(opened.title)}`)
      if (!opened.message) problems.push(`opened message of ${id} not visible`)
      if (opened.recordUsed !== (entry.cache === 'valid')) problems.push(`record use of ${id}: ${String(opened.recordUsed)}`)
    }
  }
  return problems
}

const entries = manifest()
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-list-lazy-batch-'))
  const writer = new Context()
  await writer.plugin(SessionStore)
  await writer.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  const dir = join(root, 'cache', projectionCacheDomainSpec.name, 'sessions')
  await mkdir(dir, { recursive: true })
  const now = Date.now()
  for (let start = 0; start < entries.length; start += 250) {
    await Promise.all(entries.slice(start, start + 250).map(async (entry) => {
      const handle = await writer.sessionPersistence.create(entry.header)
      const events: SessionEvent[] = [
        { type: 'session/title', seq: SessionSeq(0), time: 1, data: { title: entry.title, messageSeqs: [], source: { kind: 'user' } } },
        { type: 'user/message', seq: SessionSeq(1), time: 2, data: createUserMessage({ content: [{ type: 'text', text: entry.message }], source: { kind: 'user' } }), surfaceOp: 'append' },
      ]
      await handle.append(events)
      await handle.close()
      if (entry.cache === 'missing') return
      const path = join(dir, `${entry.header.id}.json`)
      const record = {
        identity: { formatVersion: SESSION_FORMAT_VERSION, createdAt: entry.header.createdAt, cwd: '/proj', isSeeded: false, inheritedEventCount: 0 },
        rows: { title: { ver: titleProjectionDefinition.stateVersion, seq: 0, val: entry.title } },
      }
      await writeFile(path, entry.cache === 'corrupt' ? '{"version":1,"record":{"identity":' : JSON.stringify({ version: projectionCacheDomainSpec.version, record }))
      // Whole hours before a fixed start, so a window boundary entry is still inside after the test starts.
      const when = new Date(now - entry.ageHours * 3_600_000 + 60_000)
      await utimes(path, when, when)
    }))
  }
  await writer.fiber.dispose()
}, 300_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('10001 Sessions with real logs over the bounded cache', () => {
  it('lists, folds, and cold-opens every Session as the manifest says while complete residents stay bounded', async () => {
    const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, 'cache') })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.sessionProjections.register(titleProjectionDefinition)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
      vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      await ctx.plugin(SessionProjectionCache, {
        writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays: WINDOW_DAYS, maxResidentRecords: CAP,
      })
      installSessionReadTestServices(ctx)
      ctx.provide('attachments', { imageLimits: TEST_IMAGE_LIMITS } as never)
      const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
      const startup = new Set<string>(table.keys())
      const startupReads = reads.mock.calls.length
      let maxResident = table.size

      const sampler = setInterval(() => { maxResident = Math.max(maxResident, table.size) }, 5)
      // Cold-open every Session through the observation path first: opening writes no cache record,
      // so missing and corrupt records still fall back to the log here.
      const ensure = vi.spyOn(ctx.sessionProjectionCache, 'ensureLoaded')
      const opened = new Map<string, { title: unknown; message: boolean; recordUsed: boolean }>()
      for (const entry of entries) {
        const before = ensure.mock.results.length
        const observation = await ctx.sessionQuery.observeSession(entry.header.id)
        const used = await (ensure.mock.results[before]?.value as Promise<boolean> | undefined)
        opened.set(entry.header.id, {
          title: observation.projections?.values.title,
          message: observation.events.some(event => event.type === 'user/message'
            && event.data.content.some(part => part.type === 'text' && part.text === entry.message)),
          recordUsed: used === true,
        })
        observation[Symbol.dispose]()
        maxResident = Math.max(maxResident, table.size)
      }

      // Then list every Session; cold rows publish through the backfill queue.
      const backfilled: SessionSummary[] = []
      const list = new ApiSessionList(ctx, 8, { maxLogBytes: 1_000_000, concurrency: 8, onBackfilled: (row) => { backfilled.push(row) } })
      await list.initialize()
      const open = vi.spyOn(ctx.sessionPersistence, 'open')
      const rows = await list.list()
      const listedTitles = new Map<string, unknown>(rows.map(row => [row.sessionId, row.projections?.values.title]))
      const pending = rows.filter(row => row.projections === undefined).length
      await vi.waitFor(() => { expect(backfilled).toHaveLength(pending) }, { timeout: 240_000, interval: 50 })
      for (const row of backfilled) listedTitles.set(row.sessionId, row.projections?.values.title)
      const listFolds = new Set<string>(open.mock.calls.map(([id]) => id))
      // A refresh serves every row from memory and folds no further log.
      const opensBefore = open.mock.calls.length
      const again = await list.list()
      expect(again.filter(row => row.projections === undefined)).toEqual([])
      expect(open.mock.calls.length).toBe(opensBefore)

      clearInterval(sampler)

      expect(judge(entries, { startup, listedTitles, listFolds, opened })).toEqual([])
      expect(startupReads).toBeLessThanOrEqual(CAP)
      expect(maxResident).toBeLessThanOrEqual(CAP)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 600_000)

  it('the judge flags a stale record admitted at startup, a dropped row, a needless fold, and a wrong opened title', () => {
    const valid = entries.filter(entry => entry.cache === 'valid')
    type Opened = { title: unknown; message: boolean; recordUsed: boolean }
    const truth = (): Observed & { listedTitles: Map<string, unknown>; opened: Map<string, Opened> } => ({
      startup: expectedStartup(entries),
      listedTitles: new Map(entries.map(entry => [entry.header.id, entry.title])),
      listFolds: new Set(entries.filter(entry => entry.cache !== 'valid').map(entry => entry.header.id)),
      opened: new Map(entries.map(entry => [entry.header.id, { title: entry.title, message: true, recordUsed: entry.cache === 'valid' }])),
    })
    expect(judge(entries, truth())).toEqual([])
    const stale = valid.find(entry => entry.ageHours > WINDOW_DAYS * 24)!
    expect(judge(entries, { ...truth(), startup: new Set([...expectedStartup(entries), stale.header.id]) })).toEqual([`startup extra ${stale.header.id}`])
    const dropped = truth()
    dropped.listedTitles.delete(valid[3]!.header.id)
    expect(judge(entries, dropped)).toEqual([`list dropped ${valid[3]!.header.id}`])
    expect(judge(entries, { ...truth(), listFolds: new Set([...truth().listFolds, valid[4]!.header.id]) })).toEqual([`list fold of ${valid[4]!.header.id}: true`])
    const wrong = truth()
    wrong.opened.set(valid[5]!.header.id, { title: 'other', message: true, recordUsed: true })
    expect(judge(entries, wrong)).toEqual([`opened title of ${valid[5]!.header.id}: other`])
  })
})
