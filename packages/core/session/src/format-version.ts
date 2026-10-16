/** Current logical Session format version. */

/**
 * Current logical Session format version, stamped into every newly written
 * {@link SessionHeader}. Current Session and persistence code accept only this
 * value; header-only readers classify supported historical formats, while an
 * event-body read composes the build-static adjacent chain and publishes only
 * this final generation before constructing a Session.
 *
 * The version is a single monotonic integer with no major/minor split. Retain
 * it when older readers resume correctly, preserve safely ignorable records,
 * or refuse required features before execution, mutation, or tail repair.
 * New readers must preserve historical meanings, including logs mixing old
 * and new record representations. Bump when an existing discriminator cannot
 * prevent unsafe interpretation; a structural difference alone is insufficient.
 * Unknown fields and values require evidence of the released reader's actual
 * admission behavior. The per-event {@link SessionEvent.ignorable} marker
 * governs unknown event types, not arbitrary nested payload changes.
 * Same-version readers retain earlier representations: the adjacent migration
 * chain does not run when stored and current versions match. A subsequent
 * migration must account for all supported representations of its source.
 * Compatibility review and the retained migration obligations are recorded in
 * `.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md`.
 */
export const SESSION_FORMAT_VERSION = 4
