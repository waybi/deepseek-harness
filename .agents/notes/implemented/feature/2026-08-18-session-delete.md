# Agent Note: Session delete

Status: implemented

English | [中文](2026-08-18-session-delete.zh.md)

## Problem

Archive hides a session from grouping surfaces while leaving the artifact and workspace account intact. A plugin or host path that needs a conversation gone had no persistence primitive, so any delete affordance would have removed files behind the persistence owner's back.

The earlier [session archive decision](../../archived/feature/2026-07-31-session-archive-global-set.md) replaced a visual-only Delete row with archive on purpose. That decision still holds for hide-without-destroy. This note adds a separate destroy primitive beside it.

## Decision

**Session delete is a persistence primitive, `SessionPersistence.delete(id)`, plus the `session-persistence/deleted` event. No shipped RPC or sidebar row calls it; archive remains the non-destructive hide.**

- Persistence: `delete(id)` claims the in-process write slot for the id, so an active write handle or a pending creator rejects with `SessionAlreadyOwnedError`. An unknown id rejects with `SessionPersistenceNotFoundError`. After success the id is unknown to every later `stat`, `list`, and `open`, and the id can be created again. Serialization comes from this ownership exclusion; there is no separate delete queue.
- JSONL backend: after the claim, `delete` takes the session directory's kernel lease, so another process's writer rejects with `SessionAlreadyOwnedError`. It then removes the session directory and drops the cold-log memo. The lease and claim are released in every outcome; `session-persistence/deleted` is emitted only after a successful removal.
- Workspace: the registry listens for `session-persistence/deleted` and forgets the id from the header index, every workspace account, and the archive set. Workspace registration delete still never touches session logs ([workspace registration deletion](../../archived/feature/2026-07-27-workspace-registration-deletion.md)).

## Alternatives considered

**Reuse archive as delete.** Rejected: archive is hide-without-destroy. Collapsing the two would make a misfire irreversible and would strand the future unarchive surface.

**Cancel a pending create instead of rejecting it.** Rejected: on the handle-based persistence seam a pending session is owned by its creator handle. Closing that handle already erases the pending session, so delete does not reach into another owner's state.

**Delete files directly from a plugin.** Rejected: bypassing the persistence owner races in-flight appends and leaves derived indexes holding the id.

## Consequences

Delete is permanent: the log, workspace account, and archive membership are gone. A caller must close its own write handle before deleting. Persistence contract tests pin removal, unknown-id rejection, owner rejection, and id reuse for both JSONL codecs; JSONL lease tests pin cross-process refusal, event emission, and release after a failed removal.
