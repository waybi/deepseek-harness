/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'compaction': true
  }
}

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Window fraction for pressure; capped at context window minus reserved output and `headroomTokens`. Defaults to `0.8`. */
  thresholdRatio?: number
  /**
   * Warning-level fraction of `thresholdTokens`. Reaching it lands the
   * model-free passes (`toolResultExpiry` and `toolResultPruner`) without
   * calling a model, and a pass that frees enough pressure ends the step
   * without a summary; only reaching `thresholdTokens` itself is the emergency
   * level that summarizes. A warning-level step prices the same three pressure
   * gates as an emergency step, so the extra level adds no rewrites of its own.
   *
   * Defaults to `0.8`, i.e. 80% of `thresholdTokens`. The warning band must sit
   * within reach of what the free passes actually reclaim: across 1,200 sampled
   * sessions on the development machine, 799 held prunable tool results worth a
   * median of 4,445 tokens (p90 19,167), while a 128K window at the default
   * `thresholdRatio` gives a 102,400-token threshold and therefore a
   * 20,480-token band at this ratio. A lower ratio would widen the band past
   * that reclaim, so most warning steps would find nothing left to free and
   * only the summary could clear the pressure.
   */
  prepassRatio?: number
  /**
   * Milliseconds since this session's latest cache-hitting model settlement
   * after which the provider prompt cache counts as already gone, lifting
   * `minIntervalTurns` from one pressure compaction. Rewriting history discards
   * the provider prefix cache, which is what the interval gate protects; once
   * the last settlement that read that cache is older than this, waiting again
   * protects nothing. The growth and reclaim gates still apply, and no
   * settlement time on record leaves the gate in force.
   *
   * Defaults to `3600000` (one hour). DeepSeek documents that a cache no longer
   * in use is cleared automatically within a few hours to a few days, so one
   * hour is a conservative floor rather than a provider guarantee. The same
   * machine's sampling shows how often the case arises: of 17,881 cache-hitting
   * settlements that a later user message followed, 1,404 (7.9%) resumed at
   * least an hour later, 734 (4.1%) three hours or more, and 414 (2.3%) twelve
   * hours or more. `0` treats every cache-hitting settlement as expired.
   */
  staleCacheMs?: number
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
  readonly prepassRatio: number
  readonly staleCacheMs: number
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
export type ResolvedCompactSpec = Omit<
  ResolvedTargetPolicy,
  'retainRatio' | 'retainTokens' | 'headroomTokens' | 'prepassRatio' | 'staleCacheMs'
> & {
  /** Adapter-declared full window; token budgets below exclude reserved output tokens. */
  readonly contextWindow: number
  readonly thresholdTokens: number
  /**
   * Warning-level pressure derived from `thresholdTokens` and `prepassRatio`.
   * At or above it, and below `thresholdTokens`, a pressure step lands only the
   * model-free passes. Always at or below `thresholdTokens`.
   */
  readonly prepassTokens: number
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
