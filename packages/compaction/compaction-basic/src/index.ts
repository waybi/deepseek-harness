/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger, PressureGateReading } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling services available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const pressureGateSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    minIntervalTurns: pressureGateSchema,
    minGrowthTokens: pressureGateSchema,
    minReclaimTokens: pressureGateSchema,
    maxDeferredSteps: pressureGateSchema,
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** Turn and pre-compaction measurement of the last automatic pressure compaction, per session. */
  private readonly lastPressureCompaction = new WeakMap<Session, { turn: number; tokens: number }>()
  /** Turn of the latest pre-step seen, per session; the pressure gates price against it. */
  private readonly currentTurn = new WeakMap<Session, number>
  /** Pressure steps of one turn the time-based gates deferred, per session. */
  private readonly deferredSteps = new WeakMap<Session, { turn: number | undefined; count: number }>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      this.currentTurn.set(agent.session, turn)
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')
    // Expiry normally confines its history rewrites to moments when the
    // prompt-cache prefix is already lost; compaction is such a moment, so
    // let it land its batch here before the model-free prune pass.
    const expiry = this.ctx.get('toolResultExpiry')
    /** Land the model-free passes; true when either one actually rewrote history. */
    const landFreePasses = (): boolean => {
      let rewrote = false
      if (expiry !== undefined && expiry.sweepForCompaction(agent.session).expired.length > 0) rewrote = true
      if (prune !== undefined && prune.pruneSession(agent.session).pruned.length > 0) rewrote = true
      if (rewrote) measurement = meter.measure(agent.session)
      return rewrote
    }

    if (trigger === 'context-overflow') {
      landFreePasses()
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    if (measurement.totalTokens < spec.thresholdTokens) {
      this.deferredSteps.delete(agent.session)
      return null
    }

    // Every landed compaction rewrites history and discards the provider
    // prompt-cache prefix, so pressure alone is not enough: the three gates
    // below refuse a compaction that would land too soon, after too little
    // growth, or for too little reclaimed room. Overflow recovery (above) and
    // manual `compactNow` bypass them.
    const gate = this.pressureGate(agent.session, measurement, spec.retainTokens)
    if (gate.blocked !== undefined) {
      // Hard-ceiling fallback: the gates trade a little context for cache
      // stability, never the request itself. Once the session reaches the
      // window minus reserved output and headroom, deferring again would let
      // the next request overflow, so the gates are ignored for this step.
      if (measurement.totalTokens < spec.ceilingTokens) {
        if (gate.timeBased) this.countDeferredStep(agent.session)
        this.ctx.logger.info(`compaction (step pressure) deferred: ${gate.blocked}`)
        return null
      }
      this.ctx.logger.warn(
        'compaction (step pressure) gates bypassed at hard ceiling '
        + `(${measurement.totalTokens} >= ${spec.ceilingTokens} tokens): ${gate.blocked}`,
      )
    }

    // Once pressure qualifies, land the model-free passes before choosing a
    // summary range, then remeasure through the singleton replay fold.
    const tokensBefore = measurement.totalTokens
    if (landFreePasses()) {
      // A free pass that rewrote history discarded the prompt-cache prefix just
      // like a summary would, so it counts as this session's last pressure
      // compaction: the gates above then hold off the next rewrite. Without
      // this, a pass that alone clears pressure left no record and the session
      // rewrote its history again every time it regrew past the threshold.
      this.lastPressureCompaction.set(agent.session, {
        turn: this.currentTurn.get(agent.session) ?? 0,
        tokens: tokensBefore,
      })
      this.deferredSteps.delete(agent.session)
      this.ctx.logger.info(
        `compaction (step pressure) free passes rewrote history: ${tokensBefore} -> ${measurement.totalTokens} tokens`,
      )
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal, gate.reading)
      this.lastPressureCompaction.set(agent.session, {
        turn: this.currentTurn.get(agent.session) ?? 0,
        tokens: tokensBefore,
      })
      this.deferredSteps.delete(agent.session)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Price the three pressure gates against the last automatic pressure
   * compaction of this session. Interval and growth gates stay open until a
   * first compaction has landed in this process, and once `maxDeferredSteps`
   * steps of the current turn were deferred by them; the reclaim gate reads
   * the range `selectCompactableRange` would pick under the retained tail.
   * @param session - session under pressure.
   * @param measurement - current measurement the threshold check used.
   * @param retainTokens - retained recent tail the summary range must respect.
   * @returns the gate readings, plus the first failed gate's diagnostic and
   * whether it was a time-based gate (interval or growth) when blocked.
   */
  private pressureGate(
    session: Session,
    measurement: TokenMeasurement,
    retainTokens: number,
  ): { reading: PressureGateReading; blocked?: string; timeBased?: boolean } {
    const { minIntervalTurns, minGrowthTokens, minReclaimTokens, maxDeferredSteps } = this.config
    const last = this.lastPressureCompaction.get(session)
    const turn = this.currentTurn.get(session)
    const turnsSinceLast = last === undefined || turn === undefined ? null : turn - last.turn
    const growthTokens = last === undefined ? null : measurement.totalTokens - last.tokens
    const range = selectCompactableRange(session, measurement, retainTokens)
    let reclaimTokens = 0
    if (range !== null) {
      for (const node of measurement.nodes) {
        if (node.seq >= range.start && node.seq <= range.end) reclaimTokens += node.tokens
      }
    }
    const reading: PressureGateReading = { turnsSinceLast, growthTokens, reclaimTokens }
    const fmt = `(turnsSinceLast=${String(turnsSinceLast)}, growthTokens=${String(growthTokens)}, reclaimTokens=${reclaimTokens})`
    let timeBlocked: string | undefined
    if (turnsSinceLast !== null && turnsSinceLast < minIntervalTurns) {
      timeBlocked = `minIntervalTurns ${minIntervalTurns} not reached ${fmt}`
    } else if (growthTokens !== null && growthTokens < minGrowthTokens) {
      timeBlocked = `minGrowthTokens ${minGrowthTokens} not reached ${fmt}`
    }
    if (timeBlocked !== undefined) {
      const deferred = this.deferredStepsInTurn(session)
      if (deferred < maxDeferredSteps) return { reading, blocked: timeBlocked, timeBased: true }
      // One long turn of tool steps never advances the turn count, so the
      // interval gate alone would hold until the hard ceiling while each step
      // re-reads the oversized history. After the step budget, land it now.
      this.ctx.logger.info(
        `compaction (step pressure) time gates yield after ${deferred} deferred steps this turn: ${timeBlocked}`,
      )
    }
    if (reclaimTokens < minReclaimTokens) {
      return { reading, blocked: `minReclaimTokens ${minReclaimTokens} not reached ${fmt}` }
    }
    return { reading }
  }

  /**
   * Steps of the current turn the time-based gates already deferred.
   * @param session - session under pressure.
   * @returns the count, or `0` when the record belongs to another turn.
   */
  private deferredStepsInTurn(session: Session): number {
    const record = this.deferredSteps.get(session)
    return record !== undefined && record.turn === this.currentTurn.get(session) ? record.count : 0
  }

  /**
   * Record one more step of the current turn deferred by a time-based gate.
   * @param session - session whose pressure step was deferred.
   */
  private countDeferredStep(session: Session): void {
    this.deferredSteps.set(session, {
      turn: this.currentTurn.get(session),
      count: this.deferredStepsInTurn(session) + 1,
    })
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @param pressureGate - gate readings that cleared an automatic pressure compaction, recorded on `compaction/start`.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
    pressureGate?: PressureGateReading,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        ...pressureGate === undefined ? {} : { pressureGate },
      },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
