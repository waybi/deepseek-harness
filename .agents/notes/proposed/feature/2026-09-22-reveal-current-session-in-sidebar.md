# Agent Note: Reveal the current session in the sidebar tree

Status: proposed

English | [中文](2026-09-22-reveal-current-session-in-sidebar.zh.md)

## Problem

Selecting a session from anywhere other than its own sidebar row — a completion toast's go-to button, a cross-workspace inbox, search, keyboard navigation — switches the conversation but can leave the sidebar row invisible. Three independent layers in `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` hide it:

1. **Group collapse.** The current group auto-expands only when it has no recorded expansion state (`Object.hasOwn(groupExpansion, currentGroup)` guard at the `useEffect` near line 291). A group the user once collapsed stays collapsed when a session inside it becomes current.
2. **Row overflow fold.** Each expanded group renders its first `COLLAPSED_SESSION_LIMIT = 5` ordinary rows and a "Show N more" button (`collapsedSessionRows()`, line 44). The fold truncates by position and never checks `current`, so the sixth-and-later row stays behind the button even while selected.
3. **Scroll.** Nothing scrolls the tree; `scrollIntoView` does not appear in the package.

The result the user sees: the conversation pane changes, the group header tints, and the row itself is off-screen or absent. Third-party plugins cannot repair this from outside — `groupExpansion` is a slot-private store (`index.ts:142`), the overflow fold is component `useState` (`setExpandedSessionGroups`), and no service exposes a reveal.

## Proposal

Make the Workspace browser reveal the current session **when `current` changes**, and only then. A change of selection expands the containing group, includes the selected row in the folded slice, and scrolls the row into view. Collapsing a group or the fold afterwards is still honored: the effect keys on the selection change, not on render, so the user can hide the current session's group and it stays hidden until the next selection.

Concretely, three edits in `WorkspaceBrowser.tsx`:

- **Group.** Drop the `hasOwn` guard; run `setGroupExpanded(currentGroup, true)` from an effect whose dependency list is `[current, currentGroup]` (not `groupExpansion`), so it fires once per selection change and does not fight a subsequent manual collapse. The existing spec "keeps an already-expanded group when the selection moves within it" pins that manual collapse still works after a selection.
- **Fold.** Thread `current` into `collapsedSessionRows(sessions, current)`: the selected row is always in `rows`; the ordinary-row budget still admits the first five others, and `hiddenCount` counts the rest. `sessionsExpanded` state is untouched, so "Show N more" keeps its meaning.
- **Scroll.** After the selection change has rendered, find `[role="treeitem"][aria-selected="true"]` inside the list container and call `scrollIntoView({ block: 'nearest' })`, guarded by `typeof row.scrollIntoView === 'function'` with the repository's `/* v8 ignore next -- jsdom lacks scrollIntoView */` marker (the pattern `ui-trajectory/src/client/TrajectoryTable.tsx` uses). Because the group expansion is a state update that lands one render later, the scroll effect arms a ref on `current` change and retries on each render until the row exists, then disarms.

Flat "In one list" mode has no groups or fold; only the scroll edit applies there.

## Alternatives considered

- **Always keep the current group expanded.** Simplest, but it makes the group containing the open session impossible to collapse — the spec "keeps an already-expanded group when the selection moves within it" exists precisely to preserve that freedom. Rejected.
- **Reveal from the consumer (plugin) side via DOM `scrollIntoView`.** Only addresses layer 3, and rows hidden by layers 1–2 are not in the DOM to scroll to. It is also the DOM-injection style the sidebar plugins in this deployment are moving away from.
- **Expose a `revealSession(id)` action on the Workspace browser store or as a service.** Adds a public surface for one consumer's convenience; the browser already knows `current` and can do the right thing itself. Deferred unless a consumer needs reveal without changing selection.
- **Expand the fold entirely (`setExpandedSessionGroups`) instead of including the one row.** Reveals the row but also every other hidden row, changing the group's height for an unrelated reason. Including only the selected row is the smaller visual change.

## Acceptance criteria

- With a group manually collapsed, opening a session inside it from a toast/inbox expands the group and the row is visible; clicking the group header afterwards collapses it again and the row disappears (existing spec still green).
- In a group of eight sessions, opening the eighth shows it as the sixth visible row with "Show 2 more"; opening the third leaves the fold at "Show 3 more".
- Selecting a session in a tall list scrolls the tree so the row is within the viewport (Playwright: `boundingBox` inside the list's `boundingBox`).
- `pnpm run test:gui` green; `DSH_SNAPSHOT=replay pnpm run test:web` green or, where a sidebar golden legitimately changes because a previously hidden selected row now renders, refreshed with the change called out.

## Risks

- Sidebar ARIA goldens that seed a selected session past the fold will change (a row appears). Each refresh must be explained in the PR.
- `scrollIntoView({ block: 'nearest' })` on a row inside the scroll container may also scroll an outer ancestor in some browsers; the list is the only scroll container in the column, so no observed effect is expected, but the Playwright check pins it.
- The reveal-on-change rule means a session that becomes current through host projection (for example a restored selection on reload) also expands its group on first render. This matches the old behavior for groups without recorded state and now also applies to previously collapsed ones.
