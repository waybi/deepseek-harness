/**
 * Fixed-seed batch check over 10001 stored records: a manifest generated
 * independently of the cache states, per session, whether its record exists,
 * is corrupt, falls inside the startup set, and which title it carries. The
 * judge compares the cache's startup set, every listed title, read counts,
 * and the resident bound against that manifest.
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import { PerRecordJsonUnit } from '@deepseek-ai/dsh-storage-json/src/per-record-unit.ts'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    title: string | null
  }
}

const COUNT = 10_001
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const WINDOW_DAYS = 30
// Above the in-window count, so the day window (not the cap) decides the startup set.
const CAP = 5000

interface Entry {
  readonly id: SessionId
  readonly createdAt: number
  readonly mtime: number
  readonly kind: 'cached' | 'absent' | 'corrupt'
  readonly title: string
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
  const next = random(53_118_800)
  return Array.from({ length: COUNT }, (_, index) => {
    const roll = next()
    // Whole-second mtimes, some on the exact window start and many sharing a second.
    const ageSeconds = next() < 0.05 ? WINDOW_DAYS * 86_400 : Math.floor(next() * 400 * 86_400 / 3_600) * 3_600
    return {
      id: SessionId(`batch-${String(index).padStart(5, '0')}`),
      createdAt: index,
      mtime: NOW - ageSeconds * 1000,
      kind: roll < 0.9 ? 'cached' : roll < 0.95 ? 'absent' : 'corrupt',
      title: `标题 ${String(index)} ${'x'.repeat(Math.floor(next() * 40))}`,
    }
  })
}

/** Requirement, stated directly: changed within 30 days (start inclusive), newest first, ties by id, at most CAP. */
function expectedStartup(entries: readonly Entry[]): Set<string> {
  const inWindow = entries.filter(entry => entry.kind !== 'absent' && entry.mtime >= NOW - WINDOW_DAYS * DAY)
  inWindow.sort((left, right) => right.mtime - left.mtime || (left.id < right.id ? -1 : 1))
  return new Set(inWindow.slice(0, CAP).filter(entry => entry.kind === 'cached').map(entry => entry.id))
}

const header = (entry: Entry): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: entry.id, createdAt: entry.createdAt, isSeeded: false })

let root: string
const entries = manifest()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-projcache-batch-'))
  const dir = join(root, projectionCacheDomainSpec.name, 'sessions')
  await mkdir(dir, { recursive: true })
  for (let start = 0; start < entries.length; start += 500) {
    await Promise.all(entries.slice(start, start + 500).map(async (entry) => {
      if (entry.kind === 'absent') return
      const path = join(dir, `${entry.id}.json`)
      const record = {
        identity: {
          formatVersion: SESSION_FORMAT_VERSION, createdAt: entry.createdAt, isSeeded: false, inheritedEventCount: SessionLogOffset(0),
        },
        rows: { title: { ver: 1, seq: SessionSeq(0), val: entry.title } },
      }
      await writeFile(path, entry.kind === 'corrupt' ? '{"version":7,"record":{"identity":7}}' : JSON.stringify({ version: projectionCacheDomainSpec.version, record }))
      await utimes(path, new Date(entry.mtime), new Date(entry.mtime))
    }))
  }
}, 120_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * Compare observed startup keys and listed titles with the manifest.
 * @returns one line per mismatch; empty when the cache agrees.
 */
function judge(
  manifestEntries: readonly Entry[],
  startup: ReadonlySet<string>,
  listed: ReadonlyMap<string, string | undefined>,
  expected: ReadonlySet<string> = expectedStartup(manifestEntries),
): string[] {
  const problems: string[] = []
  for (const id of expected) if (!startup.has(id)) problems.push(`startup missing ${id}`)
  for (const id of startup) if (!expected.has(id)) problems.push(`startup extra ${id}`)
  for (const entry of manifestEntries) {
    if (!listed.has(entry.id)) problems.push(`list dropped ${entry.id}`)
    const want = entry.kind === 'cached' ? entry.title : undefined
    if (listed.get(entry.id) !== want) problems.push(`title of ${entry.id}: ${String(listed.get(entry.id))} != ${String(want)}`)
  }
  return problems
}

it('agrees with the independent manifest over 10001 sessions and keeps residents bounded', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.sessionProjections.register({
    key: 'title', stateSchema: z.string().nullable(), init: () => null, apply: state => state,
    wire: { viewSchema: z.string().nullable(), view: state => state }, stateVersion: 1,
  })
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  await ctx.plugin(SessionProjectionCache, {
    writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays: WINDOW_DAYS, maxResidentRecords: CAP,
  })
  const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
  const startup = new Set<string>(table.keys())
  const startupReads = reads.mock.calls.length
  const cache = ctx.sessionProjectionCache
  const keys = ctx.sessionProjections.summaryKeys()
  const listed = new Map<string, string | undefined>()
  let maxResident = table.size
  for (const entry of entries) {
    const served = cache.cachedSnapshot(header(entry), keys) ?? await cache.loadListing(header(entry))
    listed.set(entry.id, served?.values.title ?? undefined)
    maxResident = Math.max(maxResident, table.size)
  }
  const problems = judge(entries, startup, listed)
  expect(problems).toEqual([])
  // Startup read at most the CAP newest in-window documents, never the rest.
  expect(startupReads).toBeLessThanOrEqual(CAP)
  expect(maxResident).toBeLessThanOrEqual(CAP)
  // Each stored record outside the startup set was read exactly once while listing.
  const stored = entries.filter(entry => entry.kind !== 'absent').length
  expect(reads.mock.calls.length - startupReads).toBeLessThanOrEqual(stored - startup.size + entries.filter(entry => entry.kind === 'absent').length)
  // A second pass is served from memory alone.
  const before = reads.mock.calls.length
  for (const entry of entries) {
    if (entry.kind === 'cached') expect(cache.cachedSnapshot(header(entry), keys)?.values.title).toBe(entry.title)
  }
  expect(reads.mock.calls.length).toBe(before)
}, 120_000)

it('the judge flags a stale session wrongly admitted at startup and a dropped list row', () => {
  const expected = expectedStartup(entries)
  const listed = new Map(entries.map(entry => [entry.id as string, entry.kind === 'cached' ? entry.title : undefined]))
  expect(judge(entries, expected, listed)).toEqual([])
  const stale = entries.find(entry => entry.kind === 'cached' && entry.mtime < NOW - WINDOW_DAYS * DAY)!
  expect(judge(entries, new Set([...expected, stale.id]), listed)).toEqual([`startup extra ${stale.id}`])
  const dropped = new Map(listed)
  dropped.delete(entries[7]!.id)
  expect(judge(entries, expected, dropped)[0]).toBe(`list dropped ${entries[7]!.id}`)
})
