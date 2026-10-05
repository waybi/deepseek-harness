/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Window fraction for pressure; capped at context window minus reserved output and `headroomTokens`. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Additional pressure headroom beyond the routed output reservation. Non-negative integer; defaults to `65536`. */
  headroomTokens?: number
  /** Recent context retained as a fraction of context window minus reserved output tokens. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to the resolved `headroomTokens`; an explicit cap must be positive. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
  /**
   * Minimum turns between two automatic pressure compactions of one session.
   * Every compaction rewrites history and discards the provider prompt-cache
   * prefix, so a compaction that lands too soon after the previous one pays
   * the full-price re-upload again for little reclaimed room. Overflow
   * recovery ignores this gate. Non-negative integer; defaults to `8`.
   */
  minIntervalTurns?: number
  /**
   * Minimum estimated-token growth since the previous automatic pressure
   * compaction before another may run. Blocks the loop where the summary
   * itself keeps the session at threshold. Overflow recovery ignores this
   * gate. Non-negative integer; defaults to `20000`.
   */
  minGrowthTokens?: number
  /**
   * Minimum estimated tokens a pressure compaction must be able to reclaim
   * (tokens above the threshold plus the compactable range below it) for the
   * cache loss to be worth it; smaller candidates wait for more pressure.
   * Overflow recovery ignores this gate. Non-negative integer; defaults to `10000`.
   */
  minReclaimTokens?: number
  /**
   * Pressure steps the time-based gates (`minIntervalTurns`, `minGrowthTokens`)
   * may defer within one turn. Those gates count user turns and growth, so a
   * single long turn of many tool steps would otherwise stay deferred until the
   * hard ceiling while every step re-reads the oversized history. Once this
   * many steps of the same turn were deferred by them, the next pressure step
   * ignores both; `minReclaimTokens` and the hard ceiling still apply. The
   * count resets on a new turn, when pressure clears, and when a compaction
   * lands. `0` lets every pressure step bypass the time-based gates.
   * Non-negative integer; defaults to `8`.
   */
  maxDeferredSteps?: number
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
  readonly minIntervalTurns: number
  readonly minGrowthTokens: number
  readonly minReclaimTokens: number
  readonly maxDeferredSteps: number
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens' | 'headroomTokens'> & {
  /** Adapter-declared full window; token budgets below exclude reserved output tokens. */
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  /**
   * Hard pressure ceiling. At or above it automatic pressure compaction
   * ignores the three pressure gates, so a gate-deferred session cannot grow
   * into a request the provider rejects. It is window − reserved completion
   * tokens − headroom when that lies above `thresholdTokens`; otherwise
   * (headroom caps the threshold) the midpoint between `thresholdTokens` and
   * the message budget. Always strictly above `thresholdTokens` and below the
   * message budget.
   */
  readonly ceilingTokens: number
}
