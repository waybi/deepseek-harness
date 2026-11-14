/**
 * Round-age image hydration vocabulary: the plugin policy, the durable
 * per-request decision, and its folded outcome.
 *
 * @module @deepseek-ai/dsh-compaction-image-rehydrate/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Round-age policy for resending conversation images. */
export interface ImageRehydrateConfig {
  /**
   * An image produced in a turn this many turns or more before the turn being
   * prepared is replaced on the request face by a text placeholder naming its
   * stored read-only copy. The current turn and the most recent
   * `retainRounds - 1` turns keep their images. Defaults to `2`.
   */
  retainRounds?: number
  /** Replace old images with placeholders. Defaults to `true`; `false` changes nothing. */
  enabled?: boolean
}

/** Validated, detached, deeply immutable hydration policy. */
export interface ResolvedConfig {
  readonly retainRounds: number
  readonly enabled: boolean
}

/** One image occurrence a durable decision replaced with a placeholder. */
export interface RehydratedImage {
  /** Surface node whose message carried the occurrence. */
  readonly seq: SessionSeq
  /** Zero-based depth-first image-occurrence index within that message, counting offloaded occurrences. */
  readonly imageIndex: number
  /** Absolute path of the read-only stored copy the placeholder names. */
  readonly path: string
  /** Encoded byte length of the replaced image. */
  readonly bytes: number
}

/** Outcome of one pre-step hydration pass. */
export interface RehydrateResult {
  /** Replacements in surface order. */
  readonly replaced: readonly RehydratedImage[]
  /** Total encoded bytes the request no longer carries. */
  readonly bytesReleased: number
}

/** Image occurrences one `image/rehydrate` decision replaces, within one message. */
export interface ImageRehydrateTarget {
  /** Current message-producing event carrying the occurrences. */
  seq: SessionSeq
  /** Strictly increasing occurrence indexes and the read-only path each placeholder names. */
  images: { imageIndex: number; path: string }[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Replace selected conversation images with text placeholders that name
     * their stored read-only copies. Targets name current user/message or
     * tool/result nodes; indexes count every image occurrence in depth-first
     * order, including already offloaded ones, and must strictly increase.
     * The durable messages keep their images, so replay recovers them.
     * @messageProjection
     */
    'image/rehydrate': { targets: ImageRehydrateTarget[] }
  }
}
