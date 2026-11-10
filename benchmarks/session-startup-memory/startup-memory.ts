/**
 * Startup and Session-list peak RSS with thousands of persisted projection-cache records.
 *
 * Usage (from the repository root, after `pnpm run build:artifacts`):
 *   node --import tsx/esm benchmarks/session-startup-memory/startup-memory.ts seed <private-root> <sessions>
 *   node --expose-gc --import tsx/esm benchmarks/session-startup-memory/startup-memory.ts run <private-root>
 *
 * `seed` writes header-only zstd Session logs and per-record `session_projcache` documents whose byte sizes
 * follow a fixed-seed log-normal distribution (median 148 KB, p95 about 750 KB, capped at 3 MB); document mtimes
 * spread evenly over the past 365 days. `run` mounts the Session list path of the Host (JSON storage, storage domain,
 * projection registry and cache, JSONL persistence, SQLite query engine, Session controller) over that root, then
 * prints one JSON line: peak RSS after startup, loaded cache records, peak RSS after a full list plus cold-row drain,
 * and how many listed rows carry a title. The root never touches `~/.dsh`; the caller owns and removes it.
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
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { generationLogPath, sessionDir, toHeaderLine } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { createBenchmarkSessionController } from '../session-corpus/session-controller.ts'

const CWD = '/synthetic-startup-memory'
const DAY_MS = 86_400_000
const SPAN_MS = 365 * DAY_MS
const MEDIAN_BYTES = 148_000
const SIGMA = 0.987
const MAX_BYTES = 3_000_000
/** Cache config written explicitly; the pre-change service ignores the two window fields. */
const CACHE_CONFIG = { writeEveryEvents: 200, writeIntervalMs: 5_000, startupMaxAgeDays: 30, maxResidentRecords: 300 }

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

/** Bulk filler shaped like a tool-result surface: many small objects, not one string. */
function filler(ordinal: number, bytes: number): Array<{ id: string; seq: number; text: string }> {
  const items: Array<{ id: string; seq: number; text: string }> = []
  let written = 0
  for (let index = 0; written < bytes; index++) {
    const text = `result ${ordinal}:${index} ` + 'synthetic tool output line. '.repeat(6)
    items.push({ id: `call_${ordinal}_${index}`, seq: index, text })
    written += text.length + 40
  }
  return items
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
        toolResultSurface: { ver: 1, seq: -1, val: filler(ordinal, targetBytes(next)) },
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
    const settledRssMb = Math.round(process.memoryUsage().rss / 1_000_000)
    const loadedAfterList = ctx.storageDomain.get('session_projcache')?.table('sessions').size
    assert.equal(total > 0, true)
    console.log(JSON.stringify({
      node: process.version, sessions: total, startupMs, loadedAtStartup, startupPeakRssMb,
      listPeakRssMb: peakRssMb(), settledRssMb, loadedAfterList, titledRows: titled, backfilledEvents: backfilled,
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
