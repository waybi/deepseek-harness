/**
 * Pure helpers for the sidebar's "By project prefix" grouping: Session titles
 * written by the title-prefix plugin read `prefix｜title`; rows sharing a
 * prefix are grouped, rows without a usable prefix go to a trailing
 * "Uncategorized" group. Nothing here reads or writes a stored title.
 */

/** Full-width vertical bar (U+FF5C) that separates the prefix from the title. */
export const PREFIX_SEPARATOR = '｜'

/** Longest accepted prefix, counted in Unicode code points. */
export const MAX_PREFIX_LENGTH = 16

/** Group key of the Uncategorized group; real prefix keys always start with `prefix:`. */
export const UNCATEGORIZED_GROUP_KEY = 'prefix-none'

/** Split result: `prefix` is absent when the title carries no usable prefix; `display` is then the whole title. */
export interface ParsedTitlePrefix {
  prefix: string | undefined
  display: string
}

/**
 * Split a Session title at its first full-width bar.
 * @param title - stored Session title; absent for a Session without one.
 * @returns the trimmed prefix and the text after the bar, or no prefix and the unchanged title when the
 * bar is missing, the trimmed prefix is empty, or the prefix exceeds {@link MAX_PREFIX_LENGTH} code points.
 */
export function parseTitlePrefix(title: string | undefined): ParsedTitlePrefix {
  const full = title ?? ''
  const at = full.indexOf(PREFIX_SEPARATOR)
  if (at < 0) return { prefix: undefined, display: full }
  const prefix = full.slice(0, at).trim()
  if (prefix === '' || Array.from(prefix).length > MAX_PREFIX_LENGTH) return { prefix: undefined, display: full }
  return { prefix, display: full.slice(at + PREFIX_SEPARATOR.length) }
}

/** The row facts grouping reads. */
export interface PrefixGroupRow {
  id: string
  title: string
  updatedAt: number
}

/** One group of rows sharing a prefix; `prefix` is absent for the Uncategorized group. */
export interface PrefixGroup<Row extends PrefixGroupRow> {
  key: string
  prefix: string | undefined
  rows: readonly Row[]
  /** Title text without the `prefix｜` lead, by row id; present only for rows of a prefixed group. */
  displayById: ReadonlyMap<string, string>
}

/**
 * Group ordered rows by title prefix.
 * @param rows - rows already in final single-list order (pinned, manual or recency order, filters applied);
 * each group keeps this relative order.
 * @returns prefixed groups by their newest row's `updatedAt`, descending, then the Uncategorized group last.
 */
export function groupSessionsByPrefix<Row extends PrefixGroupRow>(rows: readonly Row[]): PrefixGroup<Row>[] {
  const prefixed = new Map<string, { rows: Row[]; display: Map<string, string>; newest: number }>()
  const uncategorized: Row[] = []
  for (const row of rows) {
    const { prefix, display } = parseTitlePrefix(row.title)
    if (prefix === undefined) {
      uncategorized.push(row)
      continue
    }
    const group = prefixed.get(prefix) ?? { rows: [], display: new Map<string, string>(), newest: 0 }
    group.rows.push(row)
    group.display.set(row.id, display)
    group.newest = Math.max(group.newest, row.updatedAt)
    prefixed.set(prefix, group)
  }
  const groups: PrefixGroup<Row>[] = [...prefixed]
    .sort(([, left], [, right]) => right.newest - left.newest)
    .map(([prefix, group]) => ({
      key: `prefix:${prefix}`, prefix, rows: group.rows, displayById: group.display,
    }))
  if (uncategorized.length > 0) {
    groups.push({ key: UNCATEGORIZED_GROUP_KEY, prefix: undefined, rows: uncategorized, displayById: new Map() })
  }
  return groups
}

/**
 * Whether a group is expanded.
 * @param expansion - explicit per-group choices persisted by the user.
 * @param key - group key.
 * @returns the saved choice; without one the Uncategorized group is folded and every other group is open.
 */
export function prefixGroupExpanded(expansion: Readonly<Record<string, boolean>>, key: string): boolean {
  return expansion[key] ?? key !== UNCATEGORIZED_GROUP_KEY
}
