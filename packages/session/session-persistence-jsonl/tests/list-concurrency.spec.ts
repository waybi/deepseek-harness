import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logPath, sessionDir, toHeaderLine } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

interface HeaderReader {
  readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined>
}

describe('JSONL bounded listing', () => {
  let ctx: Context
  let root: string
  let reader: HeaderReader
  const headers = Array.from({ length: 5 }, (_, index) => meta(`bounded-${index}`, '/project'))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-list-'))
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', listConcurrency: 2 })
    for (const header of headers) {
      await mkdir(sessionDir(root, header.cwd, header.id), { recursive: true })
      await writeFile(logPath(root, header.cwd, header.id, 'none'), `${JSON.stringify(toHeaderLine(header))}\n`)
    }
    await ctx.sessionPersistence.list()
    // Instance-local barriers hold real header reads without changing process-wide filesystem state.
    reader = ctx.sessionPersistence as unknown as HeaderReader
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('overlaps independent headers without exceeding the configured limit or changing order', async () => {
    const release = Promise.withResolvers<undefined>()
    const original = reader.readFirstLine.bind(reader)
    let active = 0
    let peak = 0
    const started: string[] = []
    vi.spyOn(reader, 'readFirstLine').mockImplementation(async (path, signal) => {
      started.push(path)
      peak = Math.max(peak, ++active)
      try {
        await release.promise
        return await original(path, signal)
      } finally {
        active -= 1
      }
    })
    const pending = ctx.sessionPersistence.list()
    try {
      await vi.waitFor(() => { expect(started).toHaveLength(2) })
      expect(active).toBe(2)
      release.resolve(undefined)
      expect((await pending).map(header => header.id)).toEqual(headers.map(header => header.id))
      expect(peak).toBe(2)
      expect(active).toBe(0)
    } finally {
      release.resolve(undefined)
      await pending
    }
  })

  it('cancels queued reads but settles only after already-started headers release', async () => {
    const release = Promise.withResolvers<undefined>()
    const original = reader.readFirstLine.bind(reader)
    const controller = new AbortController()
    const reason = new Error('cancel bounded listing')
    let started = 0
    let settled = false
    vi.spyOn(reader, 'readFirstLine').mockImplementation(async (path, signal) => {
      started += 1
      await release.promise
      return original(path, signal)
    })
    const pending = ctx.sessionPersistence.list(controller.signal)
    void pending.then(() => { settled = true }, () => { settled = true })
    try {
      await vi.waitFor(() => { expect(started).toBe(2) })
      controller.abort(reason)
      await scheduler.yield()
      expect(settled).toBe(false)
      release.resolve(undefined)
      await expect(pending).rejects.toBe(reason)
      expect(started).toBe(2)
    } finally {
      controller.abort(reason)
      release.resolve(undefined)
      await pending.catch(() => undefined)
    }
  })

  it('drains other started reads before reporting a header failure', async () => {
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const failed = Promise.withResolvers<undefined>()
    const reason = new Error('header read failed')
    const original = reader.readFirstLine.bind(reader)
    let started = 0
    let settled = false
    vi.spyOn(reader, 'readFirstLine').mockImplementation(async (path, signal) => {
      const index = started++
      if (index === 0) {
        await first.promise
        failed.resolve(undefined)
        throw reason
      }
      await second.promise
      return original(path, signal)
    })
    const pending = ctx.sessionPersistence.list()
    void pending.then(() => { settled = true }, () => { settled = true })
    try {
      await vi.waitFor(() => { expect(started).toBe(2) })
      first.resolve(undefined)
      await failed.promise
      await scheduler.yield()
      expect(settled).toBe(false)
      second.resolve(undefined)
      await expect(pending).rejects.toBe(reason)
      expect(started).toBe(2)
    } finally {
      first.resolve(undefined)
      second.resolve(undefined)
      await pending.catch(() => undefined)
    }
  })

  it('bounds simultaneous listings independently and permits an append while reads wait', async () => {
    const release = Promise.withResolvers<undefined>()
    const original = reader.readFirstLine.bind(reader)
    let active = 0
    let peak = 0
    vi.spyOn(reader, 'readFirstLine').mockImplementation(async (path, signal) => {
      peak = Math.max(peak, ++active)
      try {
        await release.promise
        return await original(path, signal)
      } finally {
        active -= 1
      }
    })
    const listings = [ctx.sessionPersistence.list(), ctx.sessionPersistence.list()]
    try {
      await vi.waitFor(() => { expect(active).toBe(4) })
      const header = meta('concurrent-writer', '/writer')
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(header.id, oneTurnLog())
      expect((await stat(logPath(root, header.cwd, header.id, 'none'))).size).toBeGreaterThan(0)
      expect(active).toBe(4)
      release.resolve(undefined)
      for (const rows of await Promise.all(listings)) {
        expect(rows.map(row => row.id)).toEqual(headers.map(row => row.id))
      }
      expect(peak).toBe(4)
      expect(active).toBe(0)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled(listings)
    }
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid list concurrency %s', (listConcurrency) => {
    expect(() => JsonlSessionPersistence.Config({ root, listConcurrency })).toThrow()
  })

  it('keeps duplicate identity rejection across concurrent headers', async () => {
    const duplicate = { ...headers[0]!, id: SessionId('bounded-0'), cwd: '/other' }
    await mkdir(sessionDir(root, duplicate.cwd, duplicate.id), { recursive: true })
    await writeFile(logPath(root, duplicate.cwd, duplicate.id, 'none'), `${JSON.stringify(toHeaderLine(duplicate))}\n`)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/appears in multiple project directories/)
  })
})
