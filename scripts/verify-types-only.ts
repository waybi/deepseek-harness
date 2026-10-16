/** Reject runtime declarations and value re-exports in package `src/types.ts` modules. */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** One top-level statement that is not on the type-only allow list. */
export interface TypesOnlyViolation {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based source line of the statement start. */
  line: number
  /** Statement kind, such as `export const` or `value import`. */
  kind: string
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some(modifier => modifier.kind === kind) ?? false)
}

function isDeclared(statement: ts.Statement): boolean {
  return hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
}

function exportPrefix(statement: ts.Statement): string {
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''
}

function importKind(statement: ts.ImportDeclaration): string | undefined {
  const clause = statement.importClause
  if (clause === undefined) return 'side-effect import'
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return undefined
  const bindings = clause.namedBindings
  if (clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)) {
    return undefined
  }
  return 'value import'
}

function exportDeclarationKind(statement: ts.ExportDeclaration): string | undefined {
  if (statement.isTypeOnly) return undefined
  const clause = statement.exportClause
  if (clause === undefined) return 'export * from'
  if (ts.isNamespaceExport(clause)) return 'export * as from'
  if (clause.elements.length === 0 && statement.moduleSpecifier === undefined) return undefined
  if (clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly)) return undefined
  return statement.moduleSpecifier === undefined ? 'value export {}' : 'value export {} from'
}

function declarationKind(statement: ts.Statement): string | undefined {
  if (ts.isVariableStatement(statement)) {
    const flags = statement.declarationList.flags
    const keyword = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
    return `${exportPrefix(statement)}${keyword}`
  }
  if (ts.isFunctionDeclaration(statement)) return `${exportPrefix(statement)}function`
  if (ts.isClassDeclaration(statement)) return `${exportPrefix(statement)}class`
  if (ts.isEnumDeclaration(statement)) {
    return `${exportPrefix(statement)}${hasModifier(statement, ts.SyntaxKind.ConstKeyword) ? 'const enum' : 'enum'}`
  }
  if (ts.isModuleDeclaration(statement)) return `${exportPrefix(statement)}namespace`
  return undefined
}

/**
 * Classify one top-level statement against the type-only allow list.
 * @param statement - top-level statement of a `types.ts` source file.
 * @returns undefined when allowed, otherwise a short description of the rejected statement kind.
 */
export function classifyTypesOnlyStatement(statement: ts.Statement): string | undefined {
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return undefined
  if (ts.isImportDeclaration(statement)) return importKind(statement)
  if (ts.isExportDeclaration(statement)) return exportDeclarationKind(statement)
  if (ts.isImportEqualsDeclaration(statement)) {
    return hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export import =' : 'import = require'
  }
  if (ts.isExportAssignment(statement)) return statement.isExportEquals === true ? 'export =' : 'export default'
  const declaration = declarationKind(statement)
  if (declaration !== undefined) return isDeclared(statement) ? undefined : declaration
  return ts.SyntaxKind[statement.kind]
}

/**
 * Find top-level statements that are not type declarations, ambient declarations, or type-only imports/exports.
 * @param file - repository-relative path used in reports.
 * @param text - source contents.
 * @returns violations in source order; nested statements inside allowed declarations are not inspected.
 */
export function findTypesOnlyViolations(file: string, text: string): TypesOnlyViolation[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return source.statements.flatMap((statement) => {
    const kind = classifyTypesOnlyStatement(statement)
    if (kind === undefined) return []
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1
    return [{ file: normalized, line, kind }]
  })
}

/**
 * List every `packages/<group>/<package>/src/types.ts` file.
 * @param repoRoot - repository root.
 * @returns repository-relative paths in sorted order.
 */
export function listTypesFiles(repoRoot: string): string[] {
  const files: string[] = []
  const packages = join(repoRoot, 'packages')
  for (const group of readdirSync(packages, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(packages, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const file = `packages/${group.name}/${pkg.name}/src/types.ts`
      if (existsSync(join(repoRoot, file))) files.push(file)
    }
  }
  return files.sort()
}

/**
 * Scan all package `src/types.ts` files.
 * @param repoRoot - repository root.
 * @returns every violation across the scanned files.
 */
export function scanTypesOnly(repoRoot: string): { files: number; violations: TypesOnlyViolation[] } {
  const files = listTypesFiles(repoRoot)
  const violations = files.flatMap(file => findTypesOnlyViolations(file, readFileSync(join(repoRoot, file), 'utf8')))
  return { files: files.length, violations }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const { files, violations } = scanTypesOnly(root)
  if (violations.length > 0) {
    console.error('verify-types-only: src/types.ts contains only types — move runtime code to an adjacent module.\n'
      + violations.map(violation => `  ${violation.file}:${String(violation.line)} ${violation.kind}`).join('\n'))
    process.exitCode = 1
  } else {
    console.log(`verify-types-only: ${String(files)} src/types.ts files contain only types.`)
  }
}
