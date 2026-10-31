// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createRecentVisitsStore, RECENT_DISPLAY_LIMIT, RECENT_VISIT_LIMIT, recordVisit, selectRecentRows,
} from '../src/client/recent-visits.ts'
import type { SessionRowState } from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...overrides,
})
const listOf = (items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const rowState = (overrides: Partial<SessionRowState> = {}): SessionRowState => ({
  pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default', ...overrides,
})
const noStatus: SessionStatusSnapshot = new Map()
const visit = (sessionId: string, at: number) => ({ sessionId, at })

describe('recordVisit', () => {
  it('moves a repeated Session to the front with the new time and keeps one entry', () => {
    const next = recordVisit([visit('a', 1), visit('b', 2)], 'a', 3)
    expect(next).toEqual([visit('a', 3), visit('b', 2)])
  })

  it('trims the account to the limit, dropping the oldest', () => {
    let visits: ReturnType<typeof recordVisit> = []
    for (let i = 0; i <= RECENT_VISIT_LIMIT; i++) visits = recordVisit(visits, `s${String(i)}`, i)
    expect(visits).toHaveLength(RECENT_VISIT_LIMIT)
    expect(visits[0]?.sessionId).toBe(`s${String(RECENT_VISIT_LIMIT)}`)
    expect(visits.some(entry => entry.sessionId === 's0')).toBe(false)
  })
})

describe('createRecentVisitsStore', () => {
  beforeEach(() => { localStorage.clear() })

  it('persists visits and the collapsed flag under its own key, leaving the view store key alone', () => {
    const store = createRecentVisitsStore().create()
    store.actions.recordVisit('a', 5)
    store.actions.setCollapsed(true)
    const reloaded = createRecentVisitsStore().create()
    expect(reloaded.getSnapshot()).toEqual({ visits: [visit('a', 5)], collapsed: true })
    expect(localStorage.getItem('dsh.workspace.recent.v1')).not.toBeNull()
    expect(localStorage.getItem('dsh.workspace.view.v5')).toBeNull()
  })
})

describe('selectRecentRows', () => {
  const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id)

  it('lists the latest visit first and stops at the display limit', () => {
    const items = Array.from({ length: 8 }, (_, i) => summary(`s${String(i)}`))
    const visits = items.map((item, i) => visit(item.id, i))
    const rows = selectRecentRows(visits, listOf(items), rowState(), noStatus)
    expect(rows).toHaveLength(RECENT_DISPLAY_LIMIT)
    expect(ids(rows)).toEqual(['s7', 's6', 's5', 's4', 's3'])
  })

  it.each(['default', 'show', 'only'] as const)('never lists an archived Session (archived filter %s)', (archivedFilter) => {
    const rows = selectRecentRows(
      [visit('a', 2), visit('b', 1)],
      listOf([summary('a'), summary('b')]),
      rowState({ archivedSessionIds: [sid('a')], archivedFilter }),
      noStatus,
    )
    expect(ids(rows)).toEqual(['b'])
  })

  it('skips Sessions the list no longer knows (deleted) and blank or subagent Sessions', () => {
    const rows = selectRecentRows(
      [visit('gone', 4), visit('blank', 3), visit('child', 2), visit('ok', 1)],
      listOf([summary('blank', { blank: true }), summary('child', { origin: 'subagent' }), summary('ok')]),
      rowState(),
      noStatus,
    )
    expect(ids(rows)).toEqual(['ok'])
  })

  it('hides background Sessions by cwd prefix and id pattern, except current or running ones', () => {
    const items = [
      summary('under', { cwd: '/bg/proj' }),
      summary('pattern-1'),
      summary('current', { cwd: '/bg/x', retainedBy: { mainView: 1 } }),
      summary('busy', { cwd: '/bg/y', running: true }),
      summary('plain'),
    ]
    const state = rowState({ hiddenCwdPrefixes: ['/bg'], hiddenIdPatterns: [/^pattern-/] })
    const visits = items.map((item, i) => visit(item.id, i))
    expect(ids(selectRecentRows(visits, listOf(items), state, noStatus)).sort())
      .toEqual(['busy', 'current', 'plain'])
    expect(ids(selectRecentRows(visits, listOf(items), { ...state, showBackgroundSessions: true }, noStatus)))
      .toHaveLength(5)
  })
})
