import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName } from '@deepseek-ai/dsh-storage-json'
import { apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache/src/spec.ts'
import { toolResultSurfaceProjection } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { appendToolTurn } from './support/baseline-scenario.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Listing title used to prove the list path stays on wire projections. */
    title: string | null
  }
}

const titleUnit = {
  key: 'title',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'turn/start' ? `turn ${event.data.turn}` : state),
  stateVersion: 1,
  wire: { viewSchema: z.string().nullable(), view: state => state },
} satisfies ProjectionDefinition<'title', string | null>

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

const recordPath = (root: string, id: Session['id']): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${String(id)}.json`)

interface Seeded {
  header: SessionHeader
  events: ReturnType<Session['snapshotEvents']>
  legacyRows: Record<string, unknown>
}

/** One stored session: a large tool result and a title row, written in version-2 shape. */
function storedSession(index: number): Seeded {
  const session = Session.create(SessionId(`isolated-${index}`))
  appendToolTurn(session, 1, `call-${index}`, [{ type: 'text', text: `payload-${index}-`.repeat(12_000) }])
  session.append('turn/start', { turn: 2 })
  const events = session.snapshotEvents()
  let folded = toolResultSurfaceProjection.init()
  for (const event of events) folded = toolResultSurfaceProjection.apply(folded, event)
  const surface = folded as ToolResultSurfaceState
  const nodes = surface.nodes.map((node) => {
    const source = events[node.seq]!
    if (source.type !== 'tool/result') throw new Error(`seq ${node.seq} is not a tool/result`)
    return { seq: node.seq, turn: node.turn, callId: node.callId, toolName: node.toolName, data: source.data }
  })
  return {
    header: session.header,
    events,
    legacyRows: {
      'title': { ver: 1, seq: events.at(-1)!.seq, val: `会话 ${index}` },
      'toolResultSurface': {
        ver: 2,
        seq: events.at(-1)!.seq,
        val: { surface: [...surface.surface], nodes, toolNames: { ...surface.toolNames } },
      },
    },
  }
}

/** Seed one version-2 record document before the cache opens its domain. */
async function seed(root: string, id: Session['id'], header: SessionHeader, rows: Record<string, unknown>): Promise<void> {
  const path = recordPath(root, id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    version: projectionCacheDomainSpec.version,
    record: {
      identity: {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: header.createdAt,
        isSeeded: false,
        inheritedEventCount: SessionLogOffset(0),
      },
      rows,
    },
  }))
}

/** Read one record document's projection row versions. */
async function rowVersions(root: string, id: Session['id']): Promise<Record<string, number>> {
  const document = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as {
    record: { rows: Record<string, { ver: number }> }
  }
  return Object.fromEntries(Object.entries(document.record.rows).map(([key, row]) => [key, row.ver]))
}

/** Wait for the cache's asynchronous write-back to reach an expected row version. */
async function waitVersion(root: string, id: Session['id'], key: string, expected: number): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const versions = await rowVersions(root, id)
    if (versions[key] === expected) return versions
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`row ${key} of ${String(id)} never reached version ${expected}`)
}

describe('isolated host: version bump and listing stay per-session', () => {
  it('does not refold on listing, rewrites only the opened session, and keeps titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolated-cache-'))
    roots.push(root)
    const seeded = [storedSession(0), storedSession(1), storedSession(2)]
    for (const item of seeded) await seed(root, item.header.id, item.header, item.legacyRows)

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    let folds = 0
    await ctx.sessionProjections.register(titleUnit)
    await ctx.sessionProjections.register({
      ...toolResultSurfaceProjection,
      apply: (state: ToolResultSurfaceState, event) => {
        folds += 1
        return toolResultSurfaceProjection.apply(state, event)
      },
    })
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const cache = ctx.sessionProjectionCache

    // Listing reads only wire projections: titles arrive, no fold runs, no row changes.
    for (const item of seeded) {
      const values = cache.cachedSnapshot(item.header)?.values as Record<string, unknown> | undefined
      expect(values?.['title']).toBe(`会话 ${seeded.indexOf(item)}`)
      expect(values?.['toolResultSurface']).toBeUndefined()
    }
    expect(folds).toBe(0)
    for (const item of seeded) {
      expect(await rowVersions(root, item.header.id)).toEqual({ title: 1, toolResultSurface: 2 })
    }

    // Opening exactly one session refolds that session only.
    const beforeHeap = process.memoryUsage().heapUsed
    const cold = cache.coldSnapshot(seeded[0]!.header, SessionLogOffset(0), seeded[0]!.events)
    const refoldHeap = process.memoryUsage().heapUsed - beforeHeap
    expect(folds).toBeGreaterThan(0)
    expect((cold.values as Record<string, unknown>)['toolResultSurface']).toBeUndefined()
    const versions = await waitVersion(root, seeded[0]!.header.id, 'toolResultSurface', 3)
    for (const item of seeded.slice(1)) {
      expect(await rowVersions(root, item.header.id)).toEqual({ title: 1, toolResultSurface: 2 })
    }

    // The refreshed version-3 row seeds a later rebuild without folding the log again.
    await new Promise(resolve => setTimeout(resolve, 100))
    const foldsAfterCold = folds
    cache.coldSnapshot(seeded[0]!.header, SessionLogOffset(0), seeded[0]!.events)
    const seededHeap = process.memoryUsage().heapUsed - beforeHeap
    const seededFolds = folds - foldsAfterCold
    const report = {
      root,
      listedSessions: seeded.length,
      foldsWhileListing: 0,
      foldsOnFirstColdRead: foldsAfterCold,
      foldsOnSecondColdRead: seededFolds,
      heapDeltaRefoldBytes: refoldHeap,
      heapDeltaSeededBytes: seededHeap,
      untouchedVersions: 2,
    }
    console.log(`ISOLATED_CACHE_REPORT ${JSON.stringify(report)}`)

    expect(seededFolds).toBe(0)
    expect(versions['title']).toBe(1)
  }, 120_000)
})
