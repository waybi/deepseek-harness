# Agent Note: Attention inbox footer plugin

Status: proposed

English | [中文](2026-09-22-attention-inbox-plugin.zh.md)

## Problem

A user running many sessions across several workspaces has no single place that answers "which sessions are waiting for me right now?". The built-in sidebar shows per-row status dots (`packages/client/ui-workspace/src/client/rows/Rows.tsx` `sessionStatuses()`), but they are scattered under collapsed workspace groups, so triage means opening every group. Completion and pending-interaction toasts (the third-party `dsh-session-status-alert`) are transient and, at volume, pass by unread. Two facts the user needs are already computed on the client and never aggregated: a session that finished while unselected and has not been opened since (`SessionSummary.completed`, `packages/api/session-controller/src/client/sessions/service.ts:50`), and a session blocked on an approval, plan review, or question (`uiSession.pendingInteractions`).

## Proposal

Ship a standalone third-party Web plugin, `dsh-attention-inbox`, developed at `~/dsh-attention-inbox` and installed into the web profile like the other home-directory plugins; this repository holds only this design record. The plugin adds one footer button with a count badge and one floating panel listing every session that needs the user, flat across workspaces.

**Extension points.** Two official list slots and nothing else: `sidebar.footer.action` (declared in `packages/client/ui-sidebar/src/client/contract/slots.ts:46`, owner props `{ wide }`) for the button, and `shell.overlay` (`packages/client/ui-layout/src/client/index.ts:86`, click-through layer; the panel opts back into pointer events) for the panel. Both are registered through `ctx.slots.inject(name, () => ctx.slots.register(...))`. `dsh-session-pin` already composes the same pair, so the surface is known to hold. No DOM injection, no shadowing of `sidebar.workspaces`.

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

Priority mirrors the sidebar's `sessionStatuses()` (pending interaction outranks running and done). "Seen ⇒ disappears" costs the plugin nothing: `SessionManager.select()` clears the `completed` reminder (`packages/api/session-controller/src/client/sessions/manager.ts:182`), and a resolved interaction leaves `pendingInteractions`.

**Activation order.** Static `inject = ['sessions', 'slots']`. `uiSession` is optional and arrives through `ctx.inject(['uiSession'], cb)`, which waits for the service and rolls back when it leaves; when absent the pending group is empty and the completed group still renders. A one-shot `ctx.get('sessions')` at apply time is exactly the race that made `dsh-session-status-alert@0.2.0`'s go-to button a silent no-op (its inject listed only `timer`), so it is ruled out.

**UI.** Button: 16 px inbox glyph; label "Pending" when `wide`, count badge (`99+` cap) when `count > 0`; `aria-pressed` follows panel state. Panel: `position: fixed`, anchored bottom-left above the footer, 320 px wide, `max-height: 60vh`; header with title, count, a "include subagents" checkbox, and close; two groups, "Waiting for you" (warning dot, kind label per row) and "Finished, unseen" (done dot); rows `[dot] title · workspace`, `role=button`, Enter/Space/click → `sessions.open(id)` then close; empty state; Escape and outside click close. All colors through `--dsw-*` tokens; zh/en dictionary selected by `navigator.language`. The subagent preference lives in `localStorage` (`dsh.attention-inbox.show-subagent`, default off).

**Lifecycle.** `ctx.effect` disposer unsubscribes `sessions.list`, unsubscribes `pendingInteractions` (the other half is the `ctx.inject` rollback), and removes the style node; slot registrations leave with their fiber. The panel store is created inside `apply`, never at module level.

**Build.** Plain JS, `require('react')` only, no `@deepseek-ai/*` value imports; `scripts/build.mjs` wraps `src/client.js` in `window.__ModuleLoader__.load({ id, factory })` (the same wrapper `dsh-pinned-section` uses). `package.json` declares `dsh.client { platform: 'web', inject }` and `dsh.bundle.patch`; the patch inserts `{ id: attention-inbox, name: dsh-attention-inbox }`. Install: `cd ~/.dsh/profiles/web && pnpm add ~/dsh-attention-inbox`, restart `dsh web`, refresh. Backup follows the `tools/dsh-pinned-section` pattern in `local-tools`.

## Alternatives considered

- **Shadow `sidebar.workspaces` and render an always-visible section above a reimplemented workspace browser.** The only official way to place content between "New Session" and "Workspaces": the sidebar shell declares five slots and none sits there. It means re-implementing search, grouping, collapse, context menus, and manual ordering, and tracking every upstream browser change; `dsh-session-activity` does exactly this at a 73 KB client bundle. Rejected as disproportionate for a personal triage list.
- **DOM injection before the `sidebar.workspaces` node** (the `dsh-pinned-section` approach). Gives the always-visible section without re-implementation, but the user ruled out anything not on an official extension point, and the technique depends on borrowed CSS Module class names and a body-wide `MutationObserver`.
- **Install `dsh-session-activity` as-is.** Its attention-first sort and Focus mode approximate the need with zero code, but its secondary layout still groups by workspace, so the list is not flat across projects.
- **Wrap the built-in `WorkspaceBrowser` component and render it below the inbox.** Forbidden: a feature plugin must not runtime-import another feature plugin's values (`packages/client/AGENTS.md`, export discipline).
- **Build it as a `packages/experimental/*` workspace package.** Buys type-checked slot and `SessionSummary` contracts and removes the `local-tools` backup, at roughly double the work (TypeScript, CSS Modules, locale registration, per-file 100% coverage, bilingual README, two packages per the `client-ui-agent-team` + `agent-team-web-profile` convention). The user chose the standalone form with the design recorded here.

## Acceptance criteria

- Unit tests for `computeItems()` cover: blank skipped; current skipped; subagent toggle; pending outranks completed; ordering; `uiSession` absent degrades to completed-only.
- After install and refresh, the footer shows the button with no badge when nothing is pending.
- A background subagent finishing while another session is open increments the badge only when "include subagents" is on; the row appears under "Finished, unseen"; clicking it switches the breadcrumb to that child and the badge decrements.
- An `ask_user_question` in a non-current session increments the badge and lists a "Waiting for answer" row; answering removes it.
- Escape and an outside click close the panel; the badge count equals the row count.
- The plugin is mirrored into `local-tools/tools/dsh-attention-inbox/` (plugin copy, `install.sh`, `sync.sh`, README, registry row, README table row, `AGENTS.md` count, `validate-changed` coverage) and pushed.

## Risks

- The "finished, unseen" set is per-page memory (`completedNotifications`, `manager.ts:106`); a refresh empties that group. Accepted for v1; v2 can persist `{ sessionId: lastSeenAt }` in host settings and derive unseen as `updatedAt > lastSeenAt && !running`.
- `SessionSummary` field names and the two slot contracts are read from source, not from a published type; an upstream rename fails at runtime rather than at build. The unit tests and the end-to-end check are the only guard.
- Sessions that error out or hit a blocked goal are not surfaced: neither state reaches the client list store today. Listed as a v2 group pending a host-side event.
- The panel duplicates part of what `dsh-session-status-alert`'s grouped layout offers; the two can coexist because the inbox is pull (open when you want) and the toast is push.
