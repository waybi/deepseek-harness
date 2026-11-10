import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'
import { serializeRecord } from '../src/format.ts'

/** Paths every `readFile` call opened, so a case can prove no record content was read. */
const reads = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) => {
      reads.paths.push(path as string)
      return actual.readFile(path, options)
    }) as typeof actual.readFile,
  }
})

const DESCRIPTOR = { name: 'lazy', version: 3, compatibleVersions: [2], layout: 'per-record' as const, tables: ['t'], hasGlobal: false }

const roots: string[] = []
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-per-record-partial-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  reads.paths.length = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function document(root: string, name: string, text: string, mtimeMs?: number): Promise<void> {
  const path = join(root, 'lazy', 't', name)
  await mkdir(join(root, 'lazy', 't'), { recursive: true })
  await writeFile(path, text)
  if (mtimeMs !== undefined) await utimes(path, new Date(mtimeMs), new Date(mtimeMs))
}

it('lists record keys with mtimes without reading any document', async () => {
  const root = await freshRoot()
  await document(root, 'a.json', serializeRecord(3, { v: 'a' }), 1_700_000_000_000)
  await document(root, 'b.json', '{ not json', 1_700_000_100_000)
  await document(root, 'c.json.bak.202611101200', serializeRecord(3, { v: 'c' }))
  await document(root, 'bad key.json', serializeRecord(3, { v: 'x' }))
  await mkdir(join(root, 'lazy', 't', 'dir.json'))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)

  const stamps = await unit.listRecordStamps!('t')

  expect(stamps.toSorted((left, right) => left.key.localeCompare(right.key))).toEqual([
    { key: 'a', modifiedAt: 1_700_000_000_000 },
    { key: 'b', modifiedAt: 1_700_000_100_000 },
  ])
  expect(reads.paths.filter(path => path.includes(join('lazy', 't')))).toEqual([])
})

it('reads one record, treating missing, malformed, unaccepted, and unsafe keys as absent', async () => {
  const root = await freshRoot()
  await document(root, 'current.json', serializeRecord(3, { v: 'current' }))
  await document(root, 'older.json', serializeRecord(2, { v: 'older' }))
  await document(root, 'stale.json', serializeRecord(1, { v: 'stale' }))
  await document(root, 'broken.json', '{"version":3,"record":')
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)

  await expect(unit.readRecord!('t', 'current')).resolves.toEqual({ v: 'current' })
  await expect(unit.readRecord!('t', 'older')).resolves.toEqual({ v: 'older' })
  await expect(unit.readRecord!('t', 'stale')).resolves.toBeUndefined()
  await expect(unit.readRecord!('t', 'broken')).resolves.toBeUndefined()
  await expect(unit.readRecord!('t', 'missing')).resolves.toBeUndefined()
  await expect(unit.readRecord!('t', '../escape')).resolves.toBeUndefined()
  // One document read per call; the unsafe key never reaches the file system.
  expect(reads.paths.filter(path => path.includes(join('lazy', 't'))).map(path => path.split('/').at(-1)))
    .toEqual(['current.json', 'older.json', 'stale.json', 'broken.json', 'missing.json'])
})

it('lists an empty table and bootstraps a legacy whole-unit file before listing', async () => {
  const emptyRoot = await freshRoot()
  const empty = new JsonStorageBackend(emptyRoot)
  onTestFinished(() => empty.close())
  await expect((await empty.kv.open(DESCRIPTOR)).listRecordStamps!('t')).resolves.toEqual([])

  const root = await freshRoot()
  await writeFile(join(root, 'lazy.json'), JSON.stringify({ unit: { name: 'lazy', version: 2 }, tables: { t: { old: { v: 'legacy' } } } }))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  expect((await unit.listRecordStamps!('t')).map(stamp => stamp.key)).toEqual(['old'])
  await expect(unit.readRecord!('t', 'old')).resolves.toEqual({ v: 'legacy' })
})

it('rejects both capabilities after close', async () => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.close()
  await expect(unit.listRecordStamps!('t')).rejects.toMatchObject({ code: 'closed' })
  await expect(unit.readRecord!('t', 'a')).rejects.toMatchObject({ code: 'closed' })
  await backend.close()
})
