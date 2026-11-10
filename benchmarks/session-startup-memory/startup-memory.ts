/**
 * Startup and Session-list peak RSS with thousands of persisted projection-cache records.
 *
 * Usage (from the repository root, after `pnpm run build:artifacts`):
 *   node --import tsx/esm benchmarks/session-startup-memory/startup-memory.ts seed <private-root> <sessions>
 *   node --expose-gc --import tsx/esm benchmarks/session-startup-memory/startup-memory.ts run <private-root>
 *
 * `seed` writes header-only zstd Session logs and per-record `session_projcache` documents whose byte sizes
 * follow a fixed-seed log-normal distribution (median 148 KB, p95 about 750 KB, capped at 3 MB); the bulk sits in a
 * `toolResultSurface` row with the real unit's state version and state fields (tool-result nodes), as in real
 * records. Document mtimes spread evenly over the past 365 days. `run` mounts the Session list path of the Host
 * (JSON storage, storage domain, projection registry with the title, tool-result surface, Session stats, and turn
 * outline units plus the controller's list metadata unit, the cache, JSONL persistence, SQLite query engine,
 * Session controller) over that root, then prints one JSON line with three phases: startup (peak RSS, loaded
 * records), a full list plus cold-row drain (peak RSS, titled rows, loaded records), and a cold open of the
 * `COLD_OPENS` oldest Sessions through `sessionQuery.observeSession` (peak RSS, loaded records). The root never
 * touches `~/.dsh`; the caller owns and removes it.
 */

import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutline from '@deepseek-ai/dsh-session-turn-outline'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { generationLogPath, sessionDir, toHeaderLine } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { toolResultSurfaceProjection } from '../../packages/compaction/compaction-tool-result-expiry/src/projection.ts'
import { createBenchmarkSessionController } from '../session-corpus/session-controller.ts'

const CWD = '/synthetic-startup-memory'
const DAY_MS = 86_400_000
const SPAN_MS = 365 * DAY_MS
const MEDIAN_BYTES = 148_000
const SIGMA = 0.987
const MAX_BYTES = 3_000_000
/** Cache config written explicitly; the pre-change service ignores the two window fields. */
const CACHE_CONFIG = { writeEveryEvents: 200, writeIntervalMs: 5_000, startupMaxAgeDays: 30, maxResidentRecords: 300 }
/** Oldest Sessions opened cold after the list drains (all outside the startup window). */
const COLD_OPENS = 500

function headerOf(ordinal: number, createdAt: number): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(`startup-mem-${ordinal}`), createdAt, cwd: CWD, isSeeded: false, delegationDepth: 0 }
}

/** Mulberry32: fixed-seed uniform numbers so every seed run writes identical documents. */
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

function targetBytes(next: () => number): number {
  const normal = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  return Math.min(MAX_BYTES, Math.max(2_000, Math.round(MEDIAN_BYTES * Math.exp(SIGMA * normal))))
}

/** A tool-result surface state (`toolResultSurface` v2 fields) of about `bytes` serialized bytes. */
function filler(ordinal: number, bytes: number): { surface: number[]; nodes: unknown[]; toolNames: Record<string, string> } {
  const surface: number[] = []
  const nodes: unknown[] = []
  let written = 0
  for (let index = 0; written < bytes; index++) {
    const seq = index * 2
    const callId = `call_${ordinal}_${index}`
    const text = `result ${ordinal}:${index} ` + 'synthetic tool output line. '.repeat(6)
    surface.push(seq)
    nodes.push({
      seq, turn: 1, callId, toolName: 'bash',
      data: { turn: 1, step: index + 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }] } },
    })
    written += text.length + 260
  }
  return { surface, nodes, toolNames: {} }
}

async function seed(root: string, sessions: number): Promise<void> {
  const next = random(20261110)
  const now = Date.now()
  const docs = join(root, 'storages', 'session_projcache', 'sessions')
  await mkdir(docs, { recursive: true })
  const sizes: number[] = []
  for (let ordinal = 0; ordinal < sessions; ordinal++) {
    const modifiedAt = now - Math.floor(ordinal * SPAN_MS / sessions)
    const header = headerOf(ordinal, modifiedAt - 60_000)
    await mkdir(sessionDir(join(root, 'sessions'), CWD, header.id), { recursive: true })
    await writeFile(generationLogPath(join(root, 'sessions'), CWD, header.id, SESSION_FORMAT_VERSION, 'zstd'),
      await compressZstdFrame(JSON.stringify(toHeaderLine(header)) + '\n'), { flag: 'wx' })
    const record = {
      identity: { formatVersion: header.version, createdAt: header.createdAt, cwd: CWD, isSeeded: false, inheritedEventCount: 0 },
      rows: {
        title: { ver: 1, seq: -1, val: `Synthetic session ${ordinal}` },
        sessionListMetadata: { ver: 1, seq: -1, val: { blank: false, lastPromptAt: header.createdAt } },
        toolResultSurface: { ver: toolResultSurfaceProjection.stateVersion, seq: -1, val: filler(ordinal, targetBytes(next)) },
      },
    }
    const text = JSON.stringify({ version: 7, record })
    const path = join(docs, `${header.id}.json`)
    await writeFile(path, text)
    await utimes(path, new Date(modifiedAt), new Date(modifiedAt))
    sizes.push(Buffer.byteLength(text))
  }
  sizes.sort((left, right) => left - right)
  const at = (q: number): number => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))]!
  console.log(JSON.stringify({ sessions, totalBytes: sizes.reduce((sum, size) => sum + size, 0), p50: at(0.5), p95: at(0.95), max: sizes.at(-1) }))
}

function peakRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS * 1024 / 1_000_000)
}

async function run(root: string): Promise<void> {
  const ctx = new Context()
  try {
    const started = performance.now()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.sessionProjections.register(titleProjectionDefinition)
    await ctx.sessionProjections.register(toolResultSurfaceProjection)
    await ctx.plugin(SessionStats)
    await ctx.plugin(SessionTurnOutline)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SessionProjectionCache, CACHE_CONFIG)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
    const dispose = (): void => {}
    ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose }, resources: { register: () => dispose } } as never)
    ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'generated-model' }) } as never)
    ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
    new RemoteAccessService(ctx)
    const controller = await createBenchmarkSessionController(ctx, { nativeOpen: false })
    const startupMs = Math.round(performance.now() - started)
    const loadedAtStartup = ctx.storageDomain.get('session_projcache')?.table('sessions').size
    const startupPeakRssMb = peakRssMb()
    let backfilled = 0
    ctx.on('api-session/added', () => { backfilled++ })
    const first = await controller.list({}, new AbortController().signal)
    const total = first.items.length
    // Drain cold-row work: stop once every row carries projections or nothing changed for 2 s.
    let titled = 0
    let quietSince = performance.now()
    let lastBackfilled = -1
    for (;;) {
      const listed = await controller.list({}, new AbortController().signal)
      titled = listed.items.filter(item => typeof item.projections?.values.title === 'string').length
      if (titled === total) break
      if (backfilled !== lastBackfilled) {
        lastBackfilled = backfilled
        quietSince = performance.now()
      } else if (performance.now() - quietSince > 2_000) {
        break
      }
      await delay(200)
    }
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
    gc?.()
    const listPeakRssMb = peakRssMb()
    const settledRssMb = Math.round(process.memoryUsage().rss / 1_000_000)
    const loadedAfterList = ctx.storageDomain.get('session_projcache')?.table('sessions').size
    // Cold-open the oldest Sessions, one at a time, as opening them from the sidebar does.
    // Seed ordinal N was written N/sessions of a year ago, so the highest ordinals are the oldest Sessions.
    const ordinalOf = (id: string): number => Number(id.slice('startup-mem-'.length))
    const oldest = [...first.items].sort((left, right) => ordinalOf(right.sessionId) - ordinalOf(left.sessionId)).slice(0, COLD_OPENS)
    const residentBeforeOpen = new Set(ctx.storageDomain.get('session_projcache')?.table('sessions').keys())
    const openedOutsideResident = oldest.filter(item => !residentBeforeOpen.has(item.sessionId)).length
    let openedTitles = 0
    let maxLoadedDuringOpen = 0
    for (const item of oldest) {
      using observation = await ctx.sessionQuery.observeSession(item.sessionId)
      if (typeof observation.projections?.values.title === 'string') openedTitles++
      maxLoadedDuringOpen = Math.max(maxLoadedDuringOpen, ctx.storageDomain.get('session_projcache')?.table('sessions').size ?? 0)
    }
    gc?.()
    const loadedAfterOpen = ctx.storageDomain.get('session_projcache')?.table('sessions').size
    assert.equal(total > 0, true)
    console.log(JSON.stringify({
      node: process.version, sessions: total, startupMs, loadedAtStartup, startupPeakRssMb,
      listPeakRssMb, settledRssMb, loadedAfterList, titledRows: titled, backfilledEvents: backfilled,
      coldOpened: oldest.length, openedOutsideResident, openedTitles, maxLoadedDuringOpen, loadedAfterOpen,
      openPeakRssMb: peakRssMb(), openSettledRssMb: Math.round(process.memoryUsage().rss / 1_000_000),
    }))
  } finally {
    await ctx.fiber.dispose()
  }
}

const [mode, root, count] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: startup-memory.ts <seed|run> <private-root> [sessions]')
if (mode === 'seed') await seed(root, Number(count ?? 7001))
else if (mode === 'run') await run(root)
else throw new Error(`unknown mode ${String(mode)}`)
