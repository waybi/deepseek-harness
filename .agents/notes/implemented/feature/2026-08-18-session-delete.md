# Agent Note: Session delete

Status: implemented

English | [中文](2026-08-18-session-delete.zh.md)

## Problem

The sidebar session menu could archive a row but could not destroy its log. Archive hides a session from grouping surfaces while leaving the artifact and workspace account intact. Users who wanted the conversation gone had no product path. The persistence seam also had no delete primitive, so any GUI affordance would have been a fake.

The earlier [session archive decision](2026-07-31-session-archive-global-set.md) replaced a visual-only Delete row with archive on purpose. That decision still holds for hide-without-destroy. This note adds a separate, confirmed destroy path beside it.

## Decision

**Session delete is a persistence primitive plus a host-owned `session.delete` RPC. The sidebar menu exposes it as a danger row that opens a confirmation dialog. Archive remains the non-destructive hide.**

- Persistence: `SessionPersistence.delete(id)` is serialized on the per-id write chain. An unknown id rejects. An un-materialized create intent is cancelled and resolves. A live persistence owner rejects. After success the id is unknown to every later operation and the coordinator emits `session-persistence/deleted`.
- Backends: JSONL unlinks the session directory (the artifact and any sibling files). SQLite deletes the `sessions` row and lets events cascade. Both return false when no artifact existed so the coordinator can distinguish an unknown id from a cancelled intent.
- Workspace: the registry listens for `session-persistence/deleted` and forgets the id from the header index, every workspace account, and the archive set. Workspace registration delete still never touches session logs ([workspace registration deletion](2026-07-27-workspace-registration-deletion.md)).
- RPC: `session.delete({ sessionId, recursive? }) → { deleted: true }`. The GUI always sends `recursive: true` because sidebar rows hide `origin: 'subagent'` children. A non-recursive request that still has `parentSession` descendants fails with `session-has-descendants`. An unknown id fails with `session-not-found`. A live session this host cannot dispose fails with `agent-busy`.
- Live teardown: the API proxy retains the `AgentHandle` from every create/resume/fork it owns and disposes those handles bottom-up before persistence delete. Continuable descendants drain through `subagents.drainContinuableDescendants` first. A session that is live but has no owned handle is refused rather than leaked.
- Client: `ctx.sessions.delete(id)` calls the RPC with `recursive: true` and drops the row on the unary echo so the sidebar does not wait for `host/session-removed`. Cold deletes also push that frame from `session-persistence/deleted` so other tabs converge.
- UI: the session menu keeps Archive (non-danger, no dialog) and adds Delete session (danger, confirmation). The dialog is browser-owned so a successful removal can unmount the row without tearing down the in-flight confirmation. Deleting the current session clears the selection the same way a `host/session-removed` mutation already does.

## Alternatives considered

**Reuse archive as delete.** Rejected: archive is hide-without-destroy. Collapsing the two would make a misfire irreversible and would strand the future unarchive surface.

**Refuse any live session.** Rejected: opening a session would then make it undeletable until host restart, because the web host retains agents. The product path must dispose the owned handle, then delete.

**Add `dispose(id)` on `AgentRegistry`.** Rejected: dispose is a consumer capability on `AgentHandle`. The API proxy already creates those handles; retaining them keeps the existing ownership rule.

**Host-side filtering instead of a list mutation.** Rejected: delete removes the durable identity. The client list must drop the row, not hide it.

## Consequences

Archive and delete now sit side by side in the same menu. Archive still has no restore surface. Delete is permanent: the log, workspace account, and archive membership are gone. Recursive GUI delete also destroys hidden subagent children; the confirmation copy states that. A live session created outside this API proxy (for example a continuable child still held only by the continuation manager after drain) can still answer `agent-busy`. Persistence contract tests pin unknown-id rejection, intent cancellation, and id reuse. The workspace-management e2e pins the GUI chain (menu → confirm → row gone → log gone).
