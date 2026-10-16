import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findTypesOnlyViolations, listTypesFiles, scanTypesOnly } from './verify-types-only.ts'

const file = 'packages/example/pkg/src/types.ts'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(root: string, path: string, contents: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-types-only-'))
  roots.push(root)
  return root
}

describe('findTypesOnlyViolations', () => {
  it.each([
    ['export const', 'export const LIMIT = 20\n', 'export const'],
    ['non-exported const', 'const LIMIT = 20\n', 'const'],
    ['let', 'export let counter = 0\n', 'export let'],
    ['export function', 'export function Id(id: string): string { return id }\n', 'export function'],
    ['export class', 'export class Failure extends Error {}\n', 'export class'],
    ['enum', 'enum Mode { A }\n', 'enum'],
    ['const enum', 'export const enum Mode { A }\n', 'export const enum'],
    ['value re-export', "export { JobId } from './brand.ts'\n", 'value export {} from'],
    ['local value export', 'export { A }\ninterface A {}\n', 'value export {}'],
    ['mixed re-export', "export { type A, B } from './a.ts'\n", 'value export {} from'],
    ['export star', "export * from './a.ts'\n", 'export * from'],
    ['export star as', "export * as a from './a.ts'\n", 'export * as from'],
    ['export default', 'export default 1\n', 'export default'],
    ['export equals', 'export = {}\n', 'export ='],
    ['import require', "import fs = require('node:fs')\n", 'import = require'],
    ['value import', "import { HarnessError } from '@deepseek-ai/dsh-llm'\n", 'value import'],
    ['mixed import', "import { brandString, type Branded } from '@deepseek-ai/dsh-brand'\n", 'value import'],
    ['default import', "import ts from 'typescript'\n", 'value import'],
    ['namespace import', "import * as ts from 'typescript'\n", 'value import'],
    ['side-effect import', "import './augment.ts'\n", 'side-effect import'],
    ['non-declare namespace', 'export namespace N { export const x = 1 }\n', 'export namespace'],
    ['expression statement', 'console.log(1)\n', 'ExpressionStatement'],
  ])('rejects %s', (_name, text, kind) => {
    const violations = findTypesOnlyViolations(file, text)

    expect(violations[0]).toEqual({ file, line: 1, kind })
  })

  it('rejects export import aliases on their own line', () => {
    const text = 'declare namespace N { type T = string }\nexport import T = N.T\n'

    expect(findTypesOnlyViolations(file, text)).toEqual([{ file, line: 2, kind: 'export import =' }])
  })

  it('reports the source line of each violation', () => {
    const text = 'export type A = string\n\n/** Doc. */\nexport const B = 1\n'

    expect(findTypesOnlyViolations(file, text)).toEqual([{ file, line: 4, kind: 'export const' }])
  })

  it.each([
    ['type alias', 'export type A = string\ntype B = number\n'],
    ['interface', 'export interface A { readonly x: string }\n'],
    ['declare module merge', "declare module '@deepseek-ai/dsh-session/types' {\n  interface SessionEventMap { 'x/y': { a: string } }\n}\n"],
    ['declare global', 'declare global {\n  interface Window { x: string }\n}\nexport {}\n'],
    ['declare const unique symbol', 'declare const Brand: unique symbol\nexport type A = { [Brand]: true }\n'],
    ['other ambient declarations', 'declare let a: string\ndeclare var b: string\ndeclare function f(): void\ndeclare class C {}\ndeclare enum E { A }\ndeclare namespace N { const x: number }\n'],
    ['empty export', 'export {}\n'],
    ['import type', "import type { Branded } from '@deepseek-ai/dsh-brand'\nimport type * as ts from 'typescript'\n"],
    ['import with all type specifiers', "import { type A, type B } from './a.ts'\n"],
    ['export type', "export type { A } from './a.ts'\nexport type * from './b.ts'\n"],
    ['export with all type specifiers', "export { type A } from './a.ts'\n"],
  ])('allows %s', (_name, text) => {
    expect(findTypesOnlyViolations(file, text)).toEqual([])
  })
})

describe('scanTypesOnly', () => {
  it('scans only packages/<group>/<package>/src/types.ts', () => {
    const root = fixture()
    write(root, 'packages/a/one/src/types.ts', 'export type A = string\n')
    write(root, 'packages/b/two/src/types.ts', 'export interface B {}\nexport const C = 1\n')
    write(root, 'packages/b/two/src/other.ts', 'export const D = 1\n')
    write(root, 'packages/b/two/src/client/types.ts', 'export const E = 1\n')
    write(root, 'packages/b/three/README.md', '# three\n')

    expect(listTypesFiles(root)).toEqual(['packages/a/one/src/types.ts', 'packages/b/two/src/types.ts'])
    expect(scanTypesOnly(root)).toEqual({
      files: 2,
      violations: [{ file: 'packages/b/two/src/types.ts', line: 2, kind: 'export const' }],
    })
  })
})
