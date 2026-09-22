# Agent Note: Attention inbox footer plugin

Status: implemented

English | [中文](2026-09-22-attention-inbox-plugin.zh.md)

## Problem

A user running many sessions across several workspaces has no single place that answers "which sessions are waiting for me right now?". The built-in sidebar shows per-row status dots (`packages/client/ui-workspace/src/client/rows/Rows.tsx` `sessionStatuses()`), but they are scattered under collapsed workspace groups, so triage means opening every group. Completion and pending-interaction toasts (the third-party `dsh-session-status-alert`) are transient and, at volume, pass by unread. Two facts the user needs are already computed on the client and never aggregated: a session that finished while unselected and has not been opened since (`SessionSummary.completed`, `packages/api/session-controller/src/client/sessions/service.ts:50`), and a session blocked on an approval, plan review, or question (`uiSession.pendingInteractions`).

## Decision

`dsh-attention-inbox` is a standalone third-party Web plugin whose only source is `local-tools/tools/dsh-attention-inbox/plugin/` (no separate checkout, no sync step; `install.sh` links that directory into the web profile and appends the name to `dsh.profile.bundles`). This repository holds this design record. The plugin adds one footer button with a count badge and one floating panel listing every session that needs the user, flat across workspaces.

**Extension points.** Two official list slots and nothing else: `sidebar.footer.action` (declared in `packages/client/ui-sidebar/src/client/contract/slots.ts:46`, owner props `{ wide }`) for the button, and `shell.overlay` (`packages/client/ui-layout/src/client/index.ts:86`, click-through layer; the panel opts back into pointer events) for the panel. Both are registered through `ctx.slots.inject(name, () => ctx.slots.register(...))`, the pair `dsh-session-pin` already composes. No DOM injection, no shadowing of `sidebar.workspaces`.

**Data sources (read-only).** `sessions.list.getSnapshot()` → `SessionListState` (`service.ts:69-80`): `byId[id]` carries `displayTitle`, `cwd`, `origin`, `parentId`, `running`, `completed`, `blank`, `updatedAt`; `current` is the open session. `uiSession.pendingInteractions.getSnapshot()` → `Map<SessionId, { kind }>` with `kind ∈ approval | plan-review | question`. The plugin writes no session state and registers no host service.

**Derivation** — one pure function `computeItems(list, pending, prefs)`:

```text
for each summary in byId:
  skip blank; skip id === current; skip origin === 'subagent' unless prefs.showSubagent
  kind = pending.get(id)?.kind ?? (summary.completed ? 'completed' : undefined)
  skip when kind is undefined
  emit { id, title: displayTitle, workspace: basename(cwd) | '(ungrouped)', kind, updatedAt }
sort: interaction kinds before 'completed'; within a kind by updatedAt descending
```

Priority mirrors the sidebar's `sessionStatuses()` (pending interaction outranks running and done). A subagent without its own `cwd` borrows the workspace name along `parentId`. "Seen ⇒ disappears" costs the plugin nothing: `SessionManager.select()` clears the `completed` reminder (`packages/api/session-controller/src/client/sessions/manager.ts:182`), and a resolved interaction leaves `pendingInteractions`.

**Activation order.** Static `inject = ['sessions', 'slots']`. `uiSession` is optional and arrives through `ctx.inject(['uiSession'], cb)`, which waits for the service and rolls back when it leaves; when absent the pending group is empty and the completed group still renders. A one-shot `ctx.get('sessions')` at apply time is the race that made `dsh-session-status-alert@0.2.0`'s go-to button a silent no-op (its inject listed only `timer`), so it is excluded.

**UI.** Button: 16 px inbox glyph; label "Pending" when `wide`, red count badge (`99+` cap) when `count > 0`; `aria-pressed` follows panel state. Panel: `position: fixed`, bottom-left above the footer, 320 px wide, `max-height: 60vh`; header with title, count, an "include subagents" checkbox, and close; two groups, "Waiting for you" (warning dot, kind label per row) and "Finished, unseen" (done dot); rows `[dot] title · workspace`, `role=button`, Enter/Space/click → `sessions.open(id)` then close; empty state; Escape and outside click close (a click on the plugin's own button is excluded so toggle and close do not cancel each other). All colors through `--dsw-*` tokens; zh/en dictionary selected by `navigator.language`. The subagent preference lives in `localStorage` (`dsh.attention-inbox.show-subagent`, default off).

**Store and lifecycle.** A closure store created inside `apply` — `{ open, showSubagent, rev }` — subscribed by both components through `React.useSyncExternalStore`; list and pending subscriptions only bump `rev` so rows recompute. The `ctx.effect` disposer unsubscribes `sessions.list`, unsubscribes `pendingInteractions` (the other half is the `ctx.inject` rollback), and removes the style node; slot registrations leave with their fiber.

**Build.** Plain JS, `require('react')` only, no `@deepseek-ai/*` value imports; `scripts/build.mjs` wraps `src/client.js` in `window.__ModuleLoader__.load({ id, factory })` (the wrapper `dsh-pinned-section` uses). `package.json` declares `dsh.client { platform: 'web', inject }` and `dsh.bundle.patch`; the patch inserts `{ id: attention-inbox, name: dsh-attention-inbox }`. The web server serves plugin bundles from disk by content hash, so after `node scripts/build.mjs` a page refresh picks up changes without restarting `dsh web`.

Because a selection made from the panel lands on a row the tree may have hidden, the companion change [reveal the current session in the sidebar tree](2026-09-22-reveal-current-session-in-sidebar.md) makes the Workspace browser expand the group, seat the row in the fold, and scroll to it.

## Alternatives considered

- **Shadow `sidebar.workspaces` and render an always-visible section above a reimplemented workspace browser.** The only official way to place content between "New Session" and "Workspaces": the sidebar shell declares five slots and none sits there. It means re-implementing search, grouping, collapse, context menus, and manual ordering, and tracking every upstream browser change; `dsh-session-activity` does exactly this at a 73 KB client bundle. Rejected as disproportionate for a personal triage list.
- **DOM injection before the `sidebar.workspaces` node** (the `dsh-pinned-section` approach). Gives the always-visible section without re-implementation, but the user ruled out anything not on an official extension point, and the technique depends on borrowed CSS Module class names and a body-wide `MutationObserver`.
- **Install `dsh-session-activity` as-is.** Its attention-first sort and Focus mode approximate the need with zero code, but its secondary layout still groups by workspace, so the list is not flat across projects.
- **Wrap the built-in `WorkspaceBrowser` component and render it below the inbox.** Forbidden: a feature plugin must not runtime-import another feature plugin's values (`packages/client/AGENTS.md`, export discipline).
- **Build it as a `packages/experimental/*` workspace package.** Buys type-checked slot and `SessionSummary` contracts and removes the `local-tools` step, at roughly double the work (TypeScript, CSS Modules, locale registration, per-file 100% coverage, bilingual README, two packages per the `client-ui-agent-team` + `agent-team-web-profile` convention). The user chose the standalone form with the design recorded here.
- **A separate source checkout under the home directory mirrored into `local-tools` by a `sync.sh`** (the `dsh-pinned-section` layout). Rejected by the user: every DSH plugin's source lives in `local-tools`, so the plugin directory there is the single source and the sync step disappears.

## Consequences

- One click answers "who is waiting for me" across every workspace; rows vanish on their own once opened or answered, because the host owns both facts.
- The "finished, unseen" set is per-page memory (`completedNotifications`, `manager.ts:106`); a refresh empties that group. Accepted for v1; a v2 could persist `{ sessionId: lastSeenAt }` in host settings and derive unseen as `updatedAt > lastSeenAt && !running`.
- `SessionSummary` field names and the two slot contracts are read from source, not from a published type; an upstream rename fails at runtime rather than at build. The unit tests and the live check are the only guard.
- Sessions that error out or hit a blocked goal are not surfaced: neither state reaches the client list store today.
- The panel overlaps part of what `dsh-session-status-alert`'s grouped layout offers; the two coexist because the inbox is pull (open when you want) and the toast is push.

## Testing

- `plugin/test/items.test.mjs` (`node --test`, 9 cases) loads the built `lib/client.js` through a stubbed `window.__ModuleLoader__` — so it also checks the wrapper — and covers: `inject` is exactly `['sessions', 'slots']`; blank and current skipped; subagent toggle and parent-`cwd` fallback; pending outranks completed with `updatedAt` ordering inside each group; unknown pending kinds ignored; `uiSession` absent degrades to completed-only; `workspaceOf` basename / parent / ungrouped / cycle-safe; `sortItems` stable and non-mutating; missing list → empty.
- `local-tools` `validate-changed --strict` covers the directory: shell syntax, `node --check` on every JS artifact, build-artifact-not-stale, and the unit tests.
- Live (ego-browser, 2026-09-22): fresh page shows the button with no badge and an empty panel; a 35 s subagent finishing while another session is open raises the badge to 1 only after "include subagents" is on, lists the row under "Finished, unseen" with the parent's workspace name, and clicking it closes the panel and clears the badge; with three real pending sessions across `Vault` and `local-tools`, jumping to one inside a manually collapsed group re-expanded the group, selected the row, kept it inside the tree viewport, and decremented the badge. Zero console errors attributable to the plugin.
