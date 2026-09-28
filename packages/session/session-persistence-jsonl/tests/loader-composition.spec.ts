/** Real YAML composition and cold discovery of plain and compressed session artifacts. */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, * as JsonlPlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const contexts = new Set<Context>()

async function dispose(context: Context): Promise<void> {
  await context.fiber.dispose()
  contexts.delete(context)
}

afterEach(async () => {
  for (const context of contexts) await dispose(context)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(compression: JsonlCompression, listConcurrency?: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const sessionsRoot = join(root, 'sessions')
  await writeFile(configPath, [
    '- id: sessions',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: persistence',
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(sessionsRoot)}`,
    `    compression: ${compression}`,
    ...listConcurrency === undefined ? [] : [`    listConcurrency: ${listConcurrency}`],
    '',
  ].join('\n'))
  return { root, configPath, sessionsRoot }
}

async function loadYaml(configPath: string): Promise<Context> {
  const context = new Context()
  contexts.add(context)
  context.baseUrl = new URL('.', pathToFileURL(configPath)).href
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionPlugin],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPlugin],
  ])
  // Resolve through Vitest's source aliases without importing a second built service singleton.
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  return context
}

function persistenceOf(context: Context): JsonlSessionPersistence {
  const persistence = context.get('sessionPersistence')
  if (!(persistence instanceof JsonlSessionPersistence)) throw new Error('JSONL service did not load')
  return persistence
}

describe('JSONL real Loader composition', () => {
  describe.each(['none', 'zstd'] as const)('%s artifacts', (compression) => {
    it.each([
      { label: 'default', listConcurrency: undefined, expectedConcurrency: 8 },
      { label: 'explicit', listConcurrency: 2, expectedConcurrency: 2 },
    ])('loads $label listConcurrency and preserves cold listing metadata', async ({
      listConcurrency, expectedConcurrency,
    }) => {
      const { root, configPath, sessionsRoot } = await fixture(compression, listConcurrency)
      const writer = await loadYaml(configPath)
      const writing = persistenceOf(writer)
      expect(writing.config.listConcurrency).toBe(expectedConcurrency)

      // The first project spans the default batch size; creation order is not directory order.
      const sessions = Array.from({ length: 11 }, (_, index) => writer.sessions.create(
        SessionId(`listed-${String(10 - index).padStart(2, '0')}`),
        { meta: {
          createdAt: 1000 + index,
          delegationDepth: index === 1 ? 1 : 0,
          ...index < 10 ? { cwd: join(root, index < 9 ? 'project-a' : 'project-b') } : {},
          ...index === 1 ? {
            origin: 'subagent',
            parentSession: SessionId('listed-10'),
            agentPreset: 'loader-child',
          } : {},
        } },
      ))
      const artifacts = new Map<string, { header: SessionHeader; bytes: Buffer }>()
      for (const session of sessions) {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        expect(await writer.sessions.flush(session)).toBe(true)
        const location = writing.locate(session.header)
        if (location.kind !== 'jsonl') throw new Error('JSONL service returned another storage kind')
        expect(location.path.endsWith(compression === 'none' ? 'session.jsonl' : 'session.jsonl.zstd')).toBe(true)
        artifacts.set(location.path, { header: session.header, bytes: await readFile(location.path) })
      }
      await dispose(writer)

      const expectedHeaders: SessionHeader[] = []
      for (const project of await readdir(sessionsRoot)) {
        for (const directory of await readdir(join(sessionsRoot, project))) {
          const filename = compression === 'none' ? 'session.jsonl' : 'session.jsonl.zstd'
          const artifact = artifacts.get(join(sessionsRoot, project, directory, filename))
          if (artifact === undefined) throw new Error('unexpected session directory')
          expectedHeaders.push(artifact.header)
        }
      }
      expect(expectedHeaders).toHaveLength(sessions.length)

      const reader = await loadYaml(configPath)
      const reading = persistenceOf(reader)
      expect(reading.config.listConcurrency).toBe(expectedConcurrency)
      expect(reader.sessions.list()).toEqual([])
      expect(await reading.list()).toEqual(expectedHeaders)
      const snapshots = await reading.listSnapshots()
      expect(snapshots.map(snapshot => snapshot.header)).toEqual(expectedHeaders)
      for (const snapshot of snapshots) {
        const inspected = await reading.inspect(snapshot.header.id)
        expect(inspected.meta).toEqual(snapshot.header)
        expect(await reading.readStoredRevision(snapshot.header.id)).toBe(snapshot.revision)
        expect(inspected.events).toEqual(
          sessions.find(session => session.id === snapshot.header.id)!.snapshotEvents(),
        )
        expect(await reading.readRaw(snapshot.header.id)).toMatchObject({
          meta: snapshot.header,
          filename: 'session.jsonl',
        })
      }
      expect(reader.sessions.list()).toEqual([])
      expect(await reading.listSnapshots()).toEqual(snapshots)
      await dispose(reader)
      for (const [path, artifact] of artifacts) expect(await readFile(path)).toEqual(artifact.bytes)
    })
  })

  it.each([0, 1.5])('rejects YAML listConcurrency %s during Loader activation', async (listConcurrency) => {
    const { configPath } = await fixture('none', listConcurrency)
    await expect(loadYaml(configPath)).rejects.toThrow(/listConcurrency/)
    for (const context of contexts) expect(context.get('sessionPersistence')).toBeUndefined()
  })
})
