/**
 * Partially loaded domains: `open(spec, { select })` reads only selected
 * records, `load` reads one more record on the write chain, `evict` drops a
 * record from memory, and writes on unloaded keys keep their semantics.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvRecordStamp, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { defineDomain, DomainError, DomainFacility, domainTable } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const spec = defineDomain({
  name: 'partial',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const strictSpec = defineDomain({
  name: 'strict',
  version: 1,
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const item = (label: string, count = 0): Item => ({ label, count })

/** Counters and hooks over a memory unit that also lists and reads single records. */
interface Probe {
  listCalls: number
  reads: string[]
  loadAllCalls: number
  backups: string[]
  /** Replace to block or fail record writes. */
  putGate: (key: string) => Promise<void>
  /** Replace to fail single-record reads. */
  readGate: (key: string) => Promise<void>
}

/** Memory backend whose units gain `listRecordStamps`, `readRecord`, and `backupRecord`. */
class PartialBackend implements StorageBackend {
  readonly kv: KvFacet
  readonly probe: Probe = {
    listCalls: 0, reads: [], loadAllCalls: 0, backups: [],
    putGate: () => Promise.resolve(), readGate: () => Promise.resolve(),
  }
  readonly stamps = new Map<string, number>()

  constructor(readonly pool = new MemoryMediaPool(), capable = true) {
    const inner = new MemoryStorageBackend(pool)
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await inner.kv.open(descriptor)
        const records = (table: string) => pool.media.get(descriptor.name)?.tables.get(table) ?? new Map<string, unknown>()
        const probe = this.probe
        const wrapped: KvUnit = {
          loadAll: () => { probe.loadAllCalls++; return unit.loadAll() },
          putRecord: async (table, key, value) => { await probe.putGate(key); await unit.putRecord(table, key, value) },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
          backupRecord: async (table, key) => {
            probe.backups.push(key)
            records(table).delete(key)
            return `${key}.bak`
          },
        }
        if (!capable) return wrapped
        return {
          ...wrapped,
          listRecordStamps: async (table): Promise<KvRecordStamp[]> => {
            probe.listCalls++
            return [...records(table).keys()].map(key => ({ key, modifiedAt: this.stamps.get(key) ?? 0 }))
          },
          readRecord: async (table, key) => {
            probe.reads.push(key)
            await probe.readGate(key)
            return records(table).get(key)
          },
        }
      },
    }
  }

  async close(): Promise<void> {}
}

async function facilityOver(backend: StorageBackend) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  return { ctx, facility }
}

/** Seed records straight onto the medium, as a previous process would have. */
function seed(pool: MemoryMediaPool, name: string, records: Record<string, unknown>): void {
  pool.versions.set(name, 1)
  pool.media.set(name, { tables: new Map([['items', new Map(Object.entries(records))]]), global: null })
}

describe('partially loaded domains', () => {
  it('reads only the selected records at open and never calls loadAll', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { a: item('a'), b: item('b'), c: item('c') })
    backend.stamps.set('a', 30).set('b', 10).set('c', 20)
    const { facility } = await facilityOver(backend)
    const seen: KvRecordStamp[][] = []
    const domain = await facility.open(spec, {
      select: { items: (stamps) => { seen.push([...stamps]); return ['a', 'c', 'missing'] } },
    })
    const table = domain.table('items')
    expect(seen[0]?.toSorted((l, r) => l.key.localeCompare(r.key))).toEqual([
      { key: 'a', modifiedAt: 30 }, { key: 'b', modifiedAt: 10 }, { key: 'c', modifiedAt: 20 },
    ])
    expect(backend.probe.loadAllCalls).toBe(0)
    expect(backend.probe.reads).toEqual(['a', 'c', 'missing'])
    expect([...table.keys()].toSorted()).toEqual(['a', 'c'])
    expect(table.get('b')).toBeUndefined()
    await domain.close()
  })

  it('opens an empty table without reading any record', async () => {
    const backend = new PartialBackend()
    const { facility } = await facilityOver(backend)
    const domain = await facility.open(spec, { select: { items: () => [] } })
    expect(domain.table('items').size).toBe(0)
    expect(backend.probe.reads).toEqual([])
    await domain.close()
  })

  it('loads an unselected record on demand and keeps it until evicted', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { a: item('a'), b: item('b', 2) })
    const { facility } = await facilityOver(backend)
    const domain = await facility.open(spec, { select: { items: () => ['a'] } })
    const table = domain.table('items')
    await expect(table.load('b')).resolves.toEqual(item('b', 2))
    expect(table.get('b')).toEqual(item('b', 2))
    await expect(table.load('nope')).resolves.toBeUndefined()
    // A resident record is served from memory without another medium read.
    backend.probe.reads.length = 0
    await table.load('b')
    expect(backend.probe.reads).toEqual([])
    expect(table.evict('b')).toBe(true)
    expect(table.get('b')).toBeUndefined()
    expect(table.evict('b')).toBe(false)
    // Eviction never touches the medium.
    expect(backend.pool.media.get('partial')?.tables.get('items')?.get('b')).toEqual(item('b', 2))
    await domain.close()
  })

  it('orders a load behind a pending write of the same key, and a failed write leaves the stored value', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { a: item('old') })
    const { facility } = await facilityOver(backend)
    const domain = await facility.open(spec, { select: { items: () => [] } })
    const table = domain.table('items')
    let release!: () => void
    backend.probe.putGate = () => new Promise<void>((resolve) => { release = resolve })
    const write = table.put('a', item('new'))
    const loaded = table.load('a')
    let settled = false
    void loaded.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await write
    await expect(loaded).resolves.toEqual(item('new'))

    // A rejected write: the load queued behind it reads what the medium holds.
    table.evict('a')
    backend.probe.putGate = () => Promise.reject(new Error('disk full'))
    const failing = table.put('a', item('lost'))
    const after = table.load('a')
    await expect(failing).rejects.toThrow('disk full')
    await expect(after).resolves.toEqual(item('new'))
    backend.probe.putGate = () => Promise.resolve()
    await table.put('a', item('next'))
    expect(table.get('a')).toEqual(item('next'))
    await domain.close()
  })

  it('applies the invalid-record policy to records read on demand', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { bad: { label: 7 } })
    seed(backend.pool, 'strict', { bad: { label: 7 } })
    const { ctx, facility } = await facilityOver(backend)
    const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const lenient = await facility.open(spec, { select: { items: () => [] } })
    await expect(lenient.table('items').load('bad')).resolves.toBeUndefined()
    expect(backend.probe.backups).toEqual(['bad'])
    expect(errors).toHaveBeenCalledOnce()
    const strict = await facility.open(strictSpec, { select: { items: () => [] } })
    await expect(strict.table('items').load('bad')).rejects.toMatchObject({ code: 'invalid-record' })
    await lenient.close()
    await strict.close()
  })

  it('deletes and updates unloaded records as stored records', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { a: item('a', 1), b: item('b'), c: item('c') })
    const { facility } = await facilityOver(backend)
    const domain = await facility.open(spec, { select: { items: () => [] } })
    const table = domain.table('items')
    await expect(table.update('a', current => ({ ...current, count: current.count + 1 }))).resolves.toEqual(item('a', 2))
    await expect(table.delete('b')).resolves.toBe(true)
    await expect(table.delete('b')).resolves.toBe(false)
    await expect(table.deleteMany(['c', 'zz'])).resolves.toBe(1)
    await expect(table.update('zz', current => current)).rejects.toMatchObject({ code: 'missing-key' })
    expect([...backend.pool.media.get('partial')?.tables.get('items')?.keys() ?? []]).toEqual(['a'])
    await domain.close()
  })

  it('rejects partial loading over a unit without the read capabilities or a spec with a global', async () => {
    const plain = new PartialBackend(new MemoryMediaPool(), false)
    const { facility } = await facilityOver(plain)
    await expect(facility.open(spec, { select: { items: () => [] } })).rejects.toMatchObject({ code: 'facet-unsupported' })
    // The failed open released the name and never fell back to a full load.
    expect(plain.probe.loadAllCalls).toBe(0)
    const withGlobal = defineDomain({
      name: 'withglobal', version: 1,
      global: { schema: z.object({ on: z.boolean() }), initial: { on: false } },
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const capable = await facilityOver(new PartialBackend())
    await expect(capable.facility.open(withGlobal, { select: {} })).rejects.toBeInstanceOf(DomainError)
  })

  it('refuses to evict from a fully loaded domain', async () => {
    const backend = new PartialBackend()
    seed(backend.pool, 'partial', { a: item('a') })
    const { facility } = await facilityOver(backend)
    const domain = await facility.open(spec)
    expect(backend.probe.loadAllCalls).toBe(1)
    expect(() => domain.table('items').evict('a')).toThrow(/fully loaded/)
    await expect(domain.table('items').load('a')).resolves.toEqual(item('a'))
    expect(backend.probe.reads).toEqual([])
    await domain.close()
  })
})
