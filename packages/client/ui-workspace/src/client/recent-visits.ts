/**
 * Browser-local "Recent" visit account for the Workspace browser: which
 * Sessions the user opened last, newest first. It lives in its own persisted
 * store so the workspace view store's `dsh.workspace.view.v5` snapshot keeps
 * its structure; the account is per browser origin and never synced.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveRecent, type SessionNode, type SessionRowState } from './tree.ts'

/** Most visits the account keeps; the oldest drops when a new Session is recorded. */
export const RECENT_VISIT_LIMIT = 20

/** Most Recent rows the sidebar section lists. */
export const RECENT_DISPLAY_LIMIT = 5

/** One recorded visit: the Session and the epoch ms of its latest open. */
export type RecentVisit = { sessionId: string; at: number }

/** Persisted Recent state: visits newest first, and whether the sidebar section is collapsed. */
export type RecentVisitsState = {
  visits: RecentVisit[]
  collapsed: boolean
}

/**
 * Record one visit.
 * @param visits - the current account, newest first.
 * @param sessionId - the Session just opened.
 * @param at - epoch ms of the open.
 * @returns a new account with the Session once, in front, trimmed to {@link RECENT_VISIT_LIMIT}.
 */
export function recordVisit(
  visits: readonly RecentVisit[],
  sessionId: string,
  at: number,
): RecentVisit[] {
  return [{ sessionId, at }, ...visits.filter(visit => visit.sessionId !== sessionId)]
    .slice(0, RECENT_VISIT_LIMIT)
}

/**
 * Pick the rows the Recent section lists.
 * @param visits - the recorded account.
 * @param list - sessions list snapshot; unknown Sessions drop out.
 * @param rowState - registry-global pin and archive sets plus background hiding. The archived filter
 * is ignored: archived Sessions never appear in Recent.
 * @param statuses - unified UI status by Session.
 * @returns at most {@link RECENT_DISPLAY_LIMIT} visible rows, latest visit first.
 */
export function selectRecentRows(
  visits: readonly RecentVisit[],
  list: SessionListState,
  rowState: SessionRowState,
  statuses: SessionStatusSnapshot,
): SessionNode[] {
  const ordered = [...visits].sort((a, b) => b.at - a.at).map(visit => visit.sessionId as SessionId)
  return deriveRecent(list, ordered, rowState, statuses).slice(0, RECENT_DISPLAY_LIMIT)
}

type RecentVisitsActions = {
  recordVisit: (draft: RecentVisitsState, sessionId: string, at: number) => void
  setCollapsed: (draft: RecentVisitsState, collapsed: boolean) => void
}

/**
 * Create the Recent visits store handle.
 * @returns the store handle; persisted under `dsh.workspace.recent.v1`.
 */
export function createRecentVisitsStore(): EngineStoreHandle<RecentVisitsState, RecentVisitsActions> {
  return defineStore({
    init: (): RecentVisitsState => ({ visits: [], collapsed: false }),
    persist: 'dsh.workspace.recent.v1',
    actions: {
      recordVisit: (d, sessionId: string, at: number) => { d.visits = recordVisit(d.visits, sessionId, at) },
      setCollapsed: (d, collapsed: boolean) => { d.collapsed = collapsed },
    },
  })
}

/** The bound write set of one Recent store instance. */
export type RecentVisitsStoreActions = ReturnType<ReturnType<typeof createRecentVisitsStore>['create']>['actions']
