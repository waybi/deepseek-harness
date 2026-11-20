/**
 * Browser-local account for the sidebar Pinned section: whether the section
 * shows every pinned Session or just the first few. The pinned Session ids
 * themselves live in the Host registry; the browser only remembers the fold,
 * so the section costs one byte of local storage and re-derives its rows from
 * the pin set instead of keeping a list.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Persisted Pinned-section state: whether the section is fully expanded. */
export type PinnedSectionState = {
  expanded: boolean
}

type PinnedSectionActions = {
  setExpanded: (draft: PinnedSectionState, expanded: boolean) => void
}

/**
 * Create the Pinned section store handle.
 * @returns the store handle; persisted under `dsh.workspace.pinned.v1`.
 */
export function createPinnedSectionStore(): EngineStoreHandle<PinnedSectionState, PinnedSectionActions> {
  return defineStore({
    init: (): PinnedSectionState => ({ expanded: false }),
    persist: 'dsh.workspace.pinned.v1',
    actions: {
      setExpanded: (d, expanded: boolean) => { d.expanded = expanded },
    },
  })
}

/** The bound write set of one Pinned section store instance. */
export type PinnedSectionStoreActions = ReturnType<ReturnType<typeof createPinnedSectionStore>['create']>['actions']
