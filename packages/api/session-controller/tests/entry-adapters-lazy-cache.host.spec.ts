/**
 * Every entry that reaches the projection cache, run against one Session
 * whose stored cache record is outside the startup window. Each adapter
 * calls the entry's own code path and asserts both the old result (the
 * Session's title and visible message match its log) and the new effect
 * (the startup set stayed within the bound, the record was read on demand
 * rather than at startup, and no clean record beyond the bound stays).
 *
 * Entry → code path:
 * - GUI backend Session list → `ApiSessionList` cold-row backfill (`loadListing`).
 * - GUI backend and remote API history projections → `HistoryController.projections` → observation (`ensureLoaded` + `hydratePrepared`).
 * - CLI one-shot `--session-id`, Session commands, skill catalog, subagent reads → `sessionQuery.observeSession`
 *   → the same observation path.
 * - GUI backend resume and continue → `AgentController` resume through the queue edit → observation, then `agents.resume`.
 * - SDK and scheduled delivery → `agents.resume` / `agents.get`: no cache read; the live Session folds its log and its record stays pinned.
 * - AI `@` mentions and the forge panel → their packages' own specs (`session-reference` cold-cache-labels,
 *   `client-ui-forge` states-remote).
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { PerRecordJsonUnit } from '@deepseek-ai/dsh-storage-json/src/per-record-unit.ts'
import { ApiSessionList } from '../src/list.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices, TEST_IMAGE_LIMITS, testSessionPersistence } from './test-remote.ts'

const DAY = 86_400_000
const BOUND = 2
const OLD = SessionId('entry-old')
const OLD_TITLE = 'Old cold title'
const OLD_MESSAGE = 'OLD_COLD_VISIBLE_MESSAGE'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

const headerOf = (id: SessionId, createdAt: number): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id, createdAt, isSeeded: false, cwd: '/proj' })

async function storedRecord(root: string, header: SessionHeader, title: string, ageDays: number): Promise<void> {
  const dir = join(root, projectionCacheDomainSpec.name, 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${header.id}.json`)
  await writeFile(path, JSON.stringify({
    version: projectionCacheDomainSpec.version,
    record: {
      identity: { formatVersion: header.version, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: titleProjectionDefinition.stateVersion, seq: 0, val: title } },
    },
  }))
  const when = new Date(Date.now() - ageDays * DAY)
  await utimes(path, when, when)
}

/** An interrupted Session: a titled turn started with a queued prompt and never ended. */
function interruptedLog(): { events: SessionEvent[]; queued: ReturnType<typeof createUserMessage> } {
  const prompt = createUserMessage({ content: [{ type: 'text', text: OLD_MESSAGE }], source: { kind: 'user' } })
  const queued = createUserMessage({ content: [{ type: 'text', text: 'still queued' }], source: { kind: 'user' } })
  return {
    queued,
    events: [
      { type: 'session/title', seq: SessionSeq(0), time: 1, data: { title: OLD_TITLE, messageSeqs: [], source: { kind: 'user' } } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, data: prompt, surfaceOp: 'append' },
      { type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 1 } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 4, data: { target: 'next-turn', start: 0, inserted: [queued] } },
    ] as SessionEvent[],
  }
}

async function composed() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-entry-lazy-'))
  roots.push(root)
  const meta = headerOf(OLD, 1000)
  await storedRecord(root, meta, OLD_TITLE, 90)
  const recent = [0, 1, 2].map(index => headerOf(SessionId(`entry-recent-${String(index)}`), index))
  for (const header of recent) await storedRecord(root, header, `recent ${header.id}`, 0)
  const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(SessionProjectionCache, {
    writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays: 30, maxResidentRecords: BOUND,
  })
  const startupReads = new Set(reads.mock.calls.map(([, key]) => key))
  const { events, queued } = interruptedLog()
  const logs = new Map<SessionId, SessionEvent[]>([[OLD, events]])
  const opens: SessionId[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: (id: SessionId) => Promise.resolve(id === OLD ? { meta, events } : undefined),
    open: (id: SessionId, access: SessionAccess): Promise<SessionHandle> => {
      opens.push(id)
      return Promise.resolve({
        id, header: meta, inheritedEventCount: SessionLogOffset(0), access,
        read: () => Promise.resolve({ eventState: 'detached', events: structuredClone(logs.get(id) ?? []) }),
        append: (appended) => { logs.get(id)?.push(...appended); return Promise.resolve() },
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      })
    },
  }) as never)
  ctx.provide('attachments', { imageLimits: TEST_IMAGE_LIMITS } as never)
  installSessionReadTestServices(ctx)
  const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
  return { ctx, reads, startupReads, opens, queued, table }
}

type Composed = Awaited<ReturnType<typeof composed>>

interface Outcome {
  readonly title: unknown
  /** Whether the Session's prompt is visible in what the entry returned; `undefined` when the entry returns no content. */
  readonly message?: boolean
  /** Whether the entry read the Session's log. */
  readonly logRead: boolean
  /** Whether the entry is expected to read the stored record on demand. */
  readonly onDemand: boolean
  /** Whether the Session is live afterwards (its record is then pinned). */
  readonly live: boolean
}

const hasPrompt = (events: readonly SessionEvent[]): boolean => events.some(event => event.type === 'user/message'
  && event.data.content.some(part => part.type === 'text' && part.text === OLD_MESSAGE))

const adapters: ReadonlyArray<readonly [string, (env: Composed) => Promise<Outcome>]> = [
  ['GUI backend: Session list', async ({ ctx, opens }) => {
    const added: SessionSummary[] = []
    const list = new ApiSessionList(ctx, 8, { maxLogBytes: 1_000_000, concurrency: 2, onBackfilled: (row) => { added.push(row) } })
    await list.initialize()
    const rows = await list.list()
    expect(rows.map(row => row.sessionId)).toEqual([OLD])
    await vi.waitFor(() => { expect(added).toHaveLength(1) })
    return { title: added[0]?.projections?.values.title, logRead: opens.includes(OLD), onDemand: true, live: false }
  }],
  ['GUI backend and remote API: history projections', async ({ ctx, opens }) => {
    const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const result = await remote.projections({ sessionId: OLD })
    if (!result.ok || result.value === null) throw new Error('projections failed')
    return { title: result.value.values.title, logRead: opens.includes(OLD), onDemand: true, live: false }
  }],
  ['CLI one-shot, Session commands, skill catalog, subagent reads: observeSession', async ({ ctx, opens }) => {
    using observation = await ctx.sessionQuery.observeSession(OLD)
    return {
      title: observation.projections?.values.title, message: hasPrompt(observation.events),
      logRead: opens.includes(OLD), onDemand: true, live: false,
    }
  }],
  ['GUI backend: resume the interrupted Session and continue', async ({ ctx, opens, queued }) => {
    const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    expect(await remote.updateQueue({ sessionId: OLD, itemId: queued.id, action: { kind: 'remove' } })).toEqual({ ok: true, value: { accepted: true } })
    const agent = ctx.agents.get(OLD)!
    expect(agent.inbox.nextTurn).toEqual([])
    return { title: ctx.sessionProjections.snapshot(agent.session, ['title']).values.title, message: hasPrompt(agent.session.snapshotEvents()), logRead: opens.includes(OLD), onDemand: true, live: true }
  }],
  ['SDK and scheduled delivery: agents.resume', async ({ ctx, opens }) => {
    const { agent } = await ctx.agents.resume({ resumeSessionId: OLD })
    return { title: ctx.sessionProjections.snapshot(agent.session, ['title']).values.title, message: hasPrompt(agent.session.snapshotEvents()), logRead: opens.includes(OLD), onDemand: false, live: true }
  }],
]

describe('every cache-reaching entry over a Session outside the startup window', () => {
  it.each(adapters)('%s', async (_entry, run) => {
    const env = await composed()
    // New effect at startup: only the recent records inside the bound loaded; the old one did not.
    expect(env.startupReads.has(OLD)).toBe(false)
    expect(env.startupReads.size).toBe(BOUND)
    expect(env.table.get(OLD)).toBeUndefined()
    env.reads.mockClear()

    const outcome = await run(env)

    // Old result: the Session is still reachable with its title and visible prompt.
    expect(outcome.title).toBe(OLD_TITLE)
    if (outcome.message !== undefined) expect(outcome.message).toBe(true)
    // New effect: an entry that consults the cache reads exactly this record on demand, and the list reads no log.
    const readKeys = env.reads.mock.calls.map(([, key]) => key)
    if (outcome.onDemand) expect(readKeys).toContain(OLD)
    expect(readKeys.every(key => key === OLD)).toBe(true)
    if (_entry.startsWith('GUI backend: Session list')) expect(outcome.logRead).toBe(false)
    // Clean complete records stay within the bound; a live Session's record may be pinned on top.
    const clean = [...env.table.keys()].filter(key => !(outcome.live && key === OLD))
    expect(clean.length).toBeLessThanOrEqual(BOUND)
  })
})
