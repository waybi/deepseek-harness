/**
 * Candidate discovery over the real projection cache when most stored
 * records are outside its bounded in-memory set: a cold Session whose
 * checkpoint is only on disk is still labeled and found by its title, without
 * any log fold, and complete records in memory stay within the bound.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import { PerRecordJsonUnit } from '@deepseek-ai/dsh-storage-json/src/per-record-unit.ts'

const DAY = 86_400_000
const COUNT = 40
const ordinalId = (ordinal: number): SessionId => SessionId(`cold-${String(ordinal).padStart(3, '0')}`)

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function compose(root: string, startupMaxAgeDays: number, maxResidentRecords: number): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000, startupMaxAgeDays, maxResidentRecords })
  // Discovery lists Sessions and reads nothing else from the query service.
  ctx.provide('sessionQuery', { listSessions: async () => [], readTitleSnapshots: async () => [] } as never)
  await ctx.plugin(SessionReferenceResolver, {})
  return ctx
}

/**
 * Write one titled checkpoint per Session through the cache itself, then age
 * record `ordinal` by `0.9 × ordinal` days so a one-day window keeps ordinals 0 and 1.
 */
async function storedCorpus(): Promise<{ root: string; headers: SessionHeader[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reference-cold-cache-'))
  roots.push(root)
  const writer = await compose(root, 30, COUNT + 10)
  const headers: SessionHeader[] = []
  for (let ordinal = 0; ordinal < COUNT; ordinal++) {
    const session = writer.sessions.create(ordinalId(ordinal), { meta: { cwd: '/work' } })
    session.append('session/title', { title: `Stored title ${ordinal}`, messageSeqs: [], source: { kind: 'user' } })
    await writer.sessionProjectionCache.write(session)
    headers.push(session.header)
  }
  contexts.splice(contexts.indexOf(writer), 1)
  await writer.fiber.dispose()
  const now = Date.now()
  for (let ordinal = 0; ordinal < COUNT; ordinal++) {
    const path = join(root, projectionCacheDomainSpec.name, 'sessions', `${ordinalId(ordinal)}.json`)
    const modified = new Date(now - ordinal * 0.9 * DAY)
    await utimes(path, modified, modified)
  }
  return { root, headers }
}

function agentOf(session: Session): Agent {
  return { id: session.id, session, options: {} } as Agent
}

describe('reference candidates over records outside the resident set', () => {
  it('finds a disk-only cold Session by its stored title and keeps complete records bounded', async () => {
    const { root, headers } = await storedCorpus()
    const reads = vi.spyOn(PerRecordJsonUnit.prototype, 'readRecord')
    const ctx = await compose(root, 1, 2)
    const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)!.table('sessions')
    // A one-day window over records aged 0, 0.9, 1.8, … days: only ordinals 0 and 1 load at startup.
    expect(new Set(table.keys())).toEqual(new Set([ordinalId(0), ordinalId(1)]))
    reads.mockClear()
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue(headers.map(header => ({ header, live: false, persisted: true })))
    const readTitles = vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots')
    const target = ctx.sessions.create(SessionId('target'), { meta: { cwd: '/work' } })

    const found = await ctx.sessionReferenceResolver.listCandidates(agentOf(target), 'Stored title 30')
    expect(found.map(candidate => [candidate.sessionId, candidate.label])).toEqual([[ordinalId(30), 'Stored title 30']])

    // Every listed Session is labeled from its stored checkpoint, none from its id.
    const all = await ctx.sessionReferenceResolver.listCandidates(agentOf(target), 'Stored title', COUNT)
    expect(new Map(all.map(candidate => [candidate.sessionId, candidate.label])))
      .toEqual(new Map(headers.map((header, ordinal) => [header.id, `Stored title ${ordinal}`])))
    // Each record outside memory was read once (38 of them); the second search read none.
    expect(reads).toHaveBeenCalledTimes(COUNT - 2)
    expect(readTitles).not.toHaveBeenCalled()
    // Complete records in memory stay within the bound; the live target is the only addition.
    expect([...table.keys()].filter(key => key !== target.id).length).toBeLessThanOrEqual(2)
  })
})
