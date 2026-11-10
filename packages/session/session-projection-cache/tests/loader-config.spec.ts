/**
 * Real Loader composition of the residency bounds: the shipped base entry, a
 * profile patch by id (with `!!js`), a patch that replaces the config block
 * with the two pre-residency fields, the same patch completed per the upgrade
 * guide, an id-only `disabled` patch, and a patch whose `name` differs. Every
 * file the composition touches lives under a private temporary root.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import * as projectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as storagePlugin from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as cachePlugin from '../src/index.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'

/** The shipped base rows this composition needs, with the cache entry exactly as base ships it. */
const BASE = `- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: '{{root}}'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
    startupMaxAgeDays: 30
    maxResidentRecords: 300
`

const NAME = '@deepseek-ai/dsh-session-projection-cache'
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-storage', storagePlugin],
  ['@deepseek-ai/dsh-storage-json', storageJsonPlugin],
  ['@deepseek-ai/dsh-storage-domain', storageDomainPlugin],
  ['@deepseek-ai/dsh-session', sessionPlugin],
  ['@deepseek-ai/dsh-session-projection', projectionPlugin],
  [NAME, cachePlugin],
])

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Boot the base rows through the real Loader and Include with `patches`
 * applied, over a private root holding `stored` cache records.
 */
async function boot(patches: PatchOptions[], stored = 3) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-loader-'))
  roots.push(root)
  const records = join(root, 'storage', projectionCacheDomainSpec.name, 'sessions')
  await mkdir(records, { recursive: true })
  for (let index = 0; index < stored; index++) {
    await writeFile(join(records, `s-${String(index)}.json`), JSON.stringify({
      version: projectionCacheDomainSpec.version,
      record: { identity: { createdAt: index }, rows: {} },
    }))
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, BASE.replace('{{root}}', join(root, 'storage').replaceAll('\\', '/')))
  const ctx = new Context()
  contexts.push(ctx)
  const errors: string[] = []
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // Every warning and error the composition reports, whatever logger it uses.
  ctx.logger.exporter({
    levels: { default: 1 },
    export: (message) => {
      if (message.type === 'warn' || message.type === 'error') errors.push(message.args.map(String).join(' '))
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches } })
  await ctx.loader.await()
  const cache = ctx.get('sessionProjectionCache')
  const table = ctx.storageDomain.get(projectionCacheDomainSpec.name)?.table('sessions')
  return { root, ctx, cache, resident: table?.size, errors }
}

const COMPLETE = { writeEveryEvents: 200, writeIntervalMs: 5000, startupMaxAgeDays: 30, maxResidentRecords: 300 }

describe('residency bounds through the real Loader', () => {
  it('applies the shipped base values', async () => {
    const { cache, resident, errors } = await boot([])
    expect(cache?.config).toEqual(COMPLETE)
    expect(resident).toBe(3)
    expect(errors).toEqual([])
  })

  it('applies a profile patch by id with an unchanged name, evaluating !!js inside config', async () => {
    const { cache, resident } = await boot([{
      id: 'session-projection-cache',
      name: NAME,
      config: { ...COMPLETE, maxResidentRecords: jsExpr('1 + 1') },
    }])
    expect(cache?.config).toEqual({ ...COMPLETE, maxResidentRecords: 2 })
    // The startup set obeys the patched bound.
    expect(resident).toBe(2)
  })

  it('rejects a config block that predates the residency fields and names the missing field', async () => {
    const { ctx, cache, errors } = await boot([{ id: 'session-projection-cache', config: { writeEveryEvents: 200, writeIntervalMs: 5000 } }])
    expect(cache).toBeUndefined()
    expect(errors.join('\n')).toMatch(/startupMaxAgeDays/)
    // Other plugins of the composition stay mounted.
    expect(ctx.get('storageDomain')).toBeDefined()
  })

  it('loads the same block once completed as the upgrade guide says', async () => {
    const { cache, errors } = await boot([{ id: 'session-projection-cache', config: { writeEveryEvents: 200, writeIntervalMs: 5000, startupMaxAgeDays: 30, maxResidentRecords: 300 } }])
    expect(cache?.config).toEqual(COMPLETE)
    expect(errors).toEqual([])
  })

  it.each([
    ['zero', 0], ['negative', -1], ['fraction', 1.5], ['string', '30'],
  ])('rejects a hand-edited %s bound with the field name', async (_label, value) => {
    const { cache, errors } = await boot([{ id: 'session-projection-cache', config: { ...COMPLETE, startupMaxAgeDays: value } }])
    expect(cache).toBeUndefined()
    expect(errors.join('\n')).toMatch(/startupMaxAgeDays/)
  })

  it('keeps an id-only disabled patch disabled and reads no record', async () => {
    const { root, ctx, cache, errors } = await boot([{ id: 'session-projection-cache', disabled: true }])
    expect(cache).toBeUndefined()
    expect(ctx.storageDomain.get(projectionCacheDomainSpec.name)).toBeUndefined()
    expect(errors).toEqual([])
    // Nothing was written outside the private root.
    expect((await readdir(root)).toSorted()).toEqual(['cordis.yml', 'storage'])
  })

  it('skips a patch whose name differs and keeps the base values', async () => {
    const { cache, errors } = await boot([{ id: 'session-projection-cache', name: '@other/cache', config: { ...COMPLETE, maxResidentRecords: 1 } }])
    expect(cache?.config).toEqual(COMPLETE)
    expect(errors.join('\n')).toMatch(/name mismatch/)
  })
})

/** A `!!js` scalar as the include plugin's YAML dialect (`entryListSchema`) parses it from a patch file. */
function jsExpr(source: string): never {
  return { __jsExpr: source } as never
}
