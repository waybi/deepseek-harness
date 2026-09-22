# Agent Note: Reveal the current session in the sidebar tree

Status: implemented

English | [中文](2026-09-22-reveal-current-session-in-sidebar.zh.md)

## Problem

Selecting a session from anywhere other than its own sidebar row — a completion toast's go-to button, a cross-workspace inbox, search, keyboard navigation — switches the conversation but could leave the sidebar row invisible. Three independent layers in `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` hid it: a group the user had once collapsed stayed collapsed when a session inside it became current (the auto-expand effect was guarded by `Object.hasOwn(groupExpansion, currentGroup)`); the five-row overflow fold truncated by position and never checked `current`, so the sixth-and-later row stayed behind "Show N more" while selected; and nothing scrolled the tree. Third-party plugins cannot repair this from outside — `groupExpansion` is a slot-private store (`index.ts:142`), the overflow fold is component `useState`, and no service exposes a reveal.

## Decision

The Workspace browser reveals the current session **when `current` changes**, and only then. A selection change expands the containing group, seats the selected row inside the folded slice, and scrolls the row into view. Collapsing the group or the fold afterwards is still honored: the effects key on the selection change, not on render, so the user can hide the current session's group and it stays hidden until the next selection.

Three mechanisms in `rows/WorkspaceBrowser.tsx`:

- **Group.** The reveal effect runs `setGroupExpanded(currentGroup, true)` with dependency list `[current, currentGroup]` — deliberately not `groupExpansion` — so it fires once per selection change and does not fight a subsequent manual collapse.
- **Fold.** `collapsedSessionRows(sessions, current)` keeps the current row in `rows`. When the current row sits past `COLLAPSED_SESSION_LIMIT` (5), it takes the last visible seat and the fifth ordinary row yields, so the visible count and the "Show N more" count are unchanged; when it is already within the first five, the fold is untouched. `sessionsExpanded` state is not involved.
- **Scroll.** A ref on the tree container plus `scrollPending` (armed with the new `current` in a `[current]` effect). A dependency-less effect runs after every render: when `scrollPending` is set and `[role="treeitem"][aria-selected="true"]` exists inside the tree, it disarms and calls `scrollIntoView({ block: 'nearest' })` behind a `typeof` guard (`/* v8 ignore */`, the `ui-trajectory` pattern). The retry-per-render is what bridges the one-render gap between the selection change and the group expansion landing.

Flat "In one list" mode has no groups or fold; only the scroll applies there.

## Alternatives considered

- **Always keep the current group expanded.** Simplest, but it makes the group containing the open session impossible to collapse — the spec "keeps an already-expanded group when the selection moves within it" exists precisely to preserve that freedom. Rejected.
- **Add the current row on top of the five-row budget** (six visible rows). First implementation; rejected because it changes the visible row count on selection and broke the spec "keeps the blank New Session outside the five-row folding quota", which pins that a current row consumes a seat. Seating replaced adding.
- **Reveal from the consumer (plugin) side via DOM `scrollIntoView`.** Only addresses scroll, and rows hidden by the group or the fold are not in the DOM to scroll to. It is also the DOM-injection style the sidebar plugins in this deployment are moving away from.
- **Expose a `revealSession(id)` action on the Workspace browser store or as a service.** Adds a public surface for one consumer's convenience; the browser already knows `current` and does the right thing itself. Deferred unless a consumer needs reveal without changing selection.
- **Expand the fold entirely (`setExpandedSessionGroups`) instead of seating the one row.** Reveals the row but also every other hidden row, changing the group's height for an unrelated reason.

## Consequences

- Any selection made outside the tree now lands on a visible, highlighted, in-viewport row: `dsh-session-status-alert`'s go-to button, `dsh-attention-inbox` ([note](2026-09-22-attention-inbox-plugin.md)), search results, and keyboard navigation all benefit without knowing about each other.
- The reveal-on-change rule also covers a session that becomes current through host projection (a restored selection on reload): its group expands on first render, including a group previously collapsed. Before, only groups with no recorded state auto-expanded.
- Sidebar ARIA goldens did not move: no committed fixture seeds a selected session past the fold or inside a collapsed group. A future fixture that does will show one extra row where the selection sits.
- `scrollIntoView({ block: 'nearest' })` scrolls only the tree list; it is the sole scroll container in the sidebar column.

## Testing

- `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`: "keeps the current session visible past the fold by giving it the last seat" (eight rows, current third → fold untouched; current eighth → rows 1–4 + 8, "Show 3 more" unchanged, `aria-selected`); "re-expands a manually collapsed group when the selection moves into it, and stays collapsible afterwards" (collapse alpha by hand, move `current` into alpha → expands; collapse again → hidden); "scrolls the selected row into view once it renders (armed on selection change)" (a recording `scrollIntoView` installed with `Object.defineProperty` and removed with `Reflect.deleteProperty`, since jsdom has none: exactly one call per selection change, none on an unrelated re-render). The pre-existing "keeps an already-expanded group when the selection moves within it" and "keeps the blank New Session outside the five-row folding quota" stay green.
- `pnpm run test:gui`: 282 files, 3908 tests green; per-file coverage on `ui-workspace/src` 100%.
- `DSH_SNAPSHOT=replay pnpm run test:web:built`: 91/93 files green; the one failure (`message-actions.e2e.ts` conversation golden, Read tool rows) is unrelated conversation-region drift present before this change.
- Live: from the `dsh-attention-inbox` panel, opening a session inside a manually collapsed `local-tools` group re-expanded the group, selected the row (`aria-selected="true"`), and placed it inside the tree's `boundingBox` (ego-browser, 2026-09-22).
