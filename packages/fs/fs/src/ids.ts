/** Branded filesystem target and version identities and their constructors. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
export type FsTargetKey = Branded<'FsTargetKey'>

/**
 * Brand a string as an {@link FsTargetKey}. For backend use only — a consumer
 * never manufactures a key, it receives one from `resolve()`.
 * @param key - the backend's raw key string (the local backend passes a realpath).
 * @returns the same string, branded; no validation is performed.
 */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from high-resolution stat identity and freshness
 * fields; a remote backend might use a revision id. The policy layer records it
 * for stale checks; consumers may display related metadata but MUST NOT
 * interpret this token.
 */
export type FsVersion = Branded<'FsVersion'>

/**
 * Brand a string as an {@link FsVersion}. For backend use only — a consumer
 * never manufactures a version, it receives one from `stat`/write/edit outcomes.
 * @param v - the backend's raw version string.
 * @returns the same string, branded; no validation is performed.
 */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}
