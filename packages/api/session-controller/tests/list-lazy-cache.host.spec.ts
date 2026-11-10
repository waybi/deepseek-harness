/**
 * Session list and resume over a projection cache whose stored records lie
 * outside the startup window: cold rows are served from their stored records
 * without reading Session logs, complete records stay within the resident
 * bound, a row without a stored record still folds its log, and an
 * interrupted Session outside the window still resumes.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { ApiSessionList } from '../src/list.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices, TEST_IMAGE_LIMITS, testSessionPersistence } from './test-remote.ts'

const DAY = 86_400_000
const CACHE_CONFIG = { writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays: 30, maxResidentRecords: 2 }

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

const evt = (type: string, seq: number, data: unknown, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ type, seq: SessionSeq(seq), time: 1000 + seq, data, ...extra }) as SessionEvent

const headerOf = (id: string, createdAt: number): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, cwd: '/proj' })

/** Write one stored cache record whose document was last changed `ageDays` ago. */
async function storedRecord(cacheRoot: string, header: SessionHeader, title: string, ageDays: number): Promise<void> {
  const dir = join(cacheRoot, projectionCacheDomainSpec.name, 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${header.id}.json`)
  await writeFile(path, JSON.stringify({
    version: projectionCacheDomainSpec.version,
    record: {
      identity: { formatVersion: header.version, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false, inheritedEventCount: 0 },
      rows: {
        title: { ver: 1, seq: 1, val: title },
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: header.createdAt + 1 } },
      },
    },
  }))
  const when = new Date(Date.now() - ageDays * DAY)
  await utimes(path, when, when)
}

describe('cold list over records outside the startup window', () => {
  it('serves every stored record without a log read and keeps complete residents bounded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-list-lazy-'))
    roots.push(root)
    const cacheRoot = join(root, 'cache')
    // A first process writes the logs; the cache records predate the window.
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const headers: SessionHeader[] = []
    for (let index = 0; index < 12; index++) {
      const header = headerOf(`cold-${String(index)}`, 100 + index)
      headers.push(header)
      const handle = await writer.sessionPersistence.create(header)
      await handle.append([evt('session/title', 0, { title: `log title ${String(index)}`, messageSeqs: [], source: { kind: 'user' } })])
      await handle.close()
      if (index < 11) await storedRecord(cacheRoot, header, `cached title ${String(index)}`, 60 + index)
    }
    await writer.fiber.dispose()

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: cacheRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(titleProjectionDefinition)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    await ctx.plugin(SessionProjectionCache, CACHE_CONFIG)
    installSessionReadTestServices(ctx)
    ctx.provide('attachments', { imageLimits: TEST_IMAGE_LIMITS } as never)
    const resident = () => ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions').size
    expect(resident()).toBe(0)
    const added: SessionSummary[] = []
    const list = new ApiSessionList(ctx, 8, { maxLogBytes: 1_000_000, concurrency: 2, onBackfilled: (summary) => { added.push(summary) } })
    await list.initialize()
    const open = vi.spyOn(ctx.sessionPersistence, 'open')

    const first = await list.list()
    expect(first.map(row => row.sessionId).toSorted()).toEqual(headers.map(header => header.id).toSorted())
    await vi.waitFor(() => { expect(added).toHaveLength(12) })
    const titles = new Map(added.map(row => [row.sessionId, row.projections?.values.title]))
    for (let index = 0; index < 11; index++) expect(titles.get(SessionId(`cold-${String(index)}`))).toBe(`cached title ${String(index)}`)
    // Only the row without a stored record read and folded its log.
    expect(titles.get(SessionId('cold-11'))).toBe('log title 11')
    expect(open.mock.calls.map(([id]) => id)).toEqual([SessionId('cold-11')])
    expect(resident()).toBeLessThanOrEqual(CACHE_CONFIG.maxResidentRecords)

    // A refresh serves every row synchronously and reads nothing more.
    const again = await list.list()
    expect(again.every(row => typeof row.projections?.values.title === 'string')).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(added).toHaveLength(12)
    expect(resident()).toBeLessThanOrEqual(CACHE_CONFIG.maxResidentRecords)
  })
})

describe('resume outside the startup window', () => {
  it('resumes an interrupted Session whose cache record is older than the window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-lazy-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.sessionProjections.register(titleProjectionDefinition)
    const sessionId = SessionId('interrupted-old')
    const meta = headerOf(sessionId, 1000)
    await storedRecord(root, meta, 'cached old title', 90)
    for (let index = 0; index < 3; index++) await storedRecord(root, headerOf(`recent-${String(index)}`, index), `recent ${String(index)}`, 0)
    await ctx.plugin(SessionProjectionCache, CACHE_CONFIG)
    const message = createUserMessage({ content: [{ type: 'text', text: 'still queued' }], source: { kind: 'user' } })
    // Interrupted: a turn started and never ended, with a queued prompt.
    const events: SessionEvent[] = [
      evt('session/title', 0, { title: 'log old title', messageSeqs: [], source: { kind: 'user' } }),
      evt('turn/start', 1, { turn: 1 }),
      evt('agent/inbox/spliced', 2, { target: 'next-turn', start: 0, inserted: [message] }),
    ]
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
      open: (_id: SessionId, access: SessionAccess): Promise<SessionHandle> => Promise.resolve({
        id: sessionId, header: meta, inheritedEventCount: SessionLogOffset(0), access,
        read: () => Promise.resolve({ eventState: 'detached', events: structuredClone(events) }),
        append: (appended) => { events.push(...appended); return Promise.resolve() },
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      }),
    }) as never)
    const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const resident = () => ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
    expect(resident().get(sessionId)).toBeUndefined()

    // The history projection read loads the stored record on demand: its title row (folded through
    // seq 1) seeds the fold, which differs from the log on purpose to show the record was used.
    const projections = await remote.projections({ sessionId })
    if (!projections.ok || projections.value === null) throw new Error('projections failed')
    expect(projections.value.values.title).toBe('cached old title')
    expect(resident().get(sessionId)).toBeDefined()

    const response = await remote.updateQueue({ sessionId, itemId: message.id, action: { kind: 'remove' } })
    expect(response).toEqual({ ok: true, value: { accepted: true } })
    const agent = ctx.agents.get(sessionId)
    expect(agent?.session.header.createdAt).toBe(1000)
    expect(agent?.inbox.nextTurn).toEqual([])
    expect(ctx.sessionProjections.snapshot(agent!.session, ['title']).values.title).toBe('log old title')
  })
})
