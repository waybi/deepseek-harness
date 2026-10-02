import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Turn-age and size policy for expiring cold tool results. */
export interface ToolResultExpiryConfig {
  /**
   * A tool result is cold once this many turns have started after the turn
   * that produced it. The current turn and the previous `coldTurns - 1` turns
   * keep their tool results verbatim. Defaults to `3`.
   */
  coldTurns?: number
  /** Expire only results whose text exceeds this many Unicode code points. Defaults to `2048`. */
  thresholdChars?: number
}

/** Validated, detached, deeply immutable expiry configuration. */
export interface ResolvedConfig {
  readonly coldTurns: number
  readonly thresholdChars: number
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface ExpiredEntry {
  /** Full-fidelity tool-result event shadowed by the stub. */
  readonly originalSeq: SessionSeq
  /** Newly appended stub tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and the stub. */
  readonly callId: ToolCallId
  /** Turn that produced the original result. */
  readonly turn: number
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Stub text size in Unicode code points. */
  readonly charsAfter: number
}

/** Aggregate outcome of one pre-step expiry pass. */
export interface ExpiryResult {
  /** Replacements in the snapshotted surface order. */
  readonly expired: readonly ExpiredEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
