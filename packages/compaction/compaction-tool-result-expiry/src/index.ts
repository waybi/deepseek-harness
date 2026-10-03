/**
 * Replay-safe, model-free expiry of cold tool results.
 *
 * Before each model request, every tool result produced `coldTurns` or more
 * turns ago whose text exceeds `thresholdChars` is replaced on the surface by a
 * one-line stub naming the tool and the removed size. The leading system prompt,
 * tool schemas, and every message before the first expired result are
 * unchanged, so provider prefix caches keep matching up to that point. Expiry
 * reads a host-only session projection of the tool-result surface, never the
 * event log, and runs regardless of token pressure: its purpose is the per-request token bill,
 * not window overflow, which `dsh-compaction-basic` owns.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-expiry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
// Type-only: the `ctx.sessionProjections` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-session-projection'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import { codePointLength, DEFAULTS, expiredStub, expiredStubWithSpill, resolveConfig } from './config.ts'
import { toolResultSurfaceProjection } from './projection.ts'
import type { ToolResultSurfaceNode, ToolResultSurfaceState } from './projection.ts'
import type {
  ExpiredEntry,
  ExpiryResult,
  ResolvedConfig,
  ToolResultExpiryConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, expiredStub, expiredStubWithSpill, resolveConfig } from './config.ts'
export { toolResultSurfaceProjection, UNNAMED_TOOL } from './projection.ts'
export type { ToolResultSurfaceNode, ToolResultSurfaceState } from './projection.ts'
export type {
  ExpiredEntry,
  ExpiryResult,
  ResolvedConfig,
  ToolResultExpiryConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultExpiry: ToolResultExpiry
  }
}

/** Matches the head of a stub this plugin emitted, so an already-expired result is never rewritten again. */
const STUB_PATTERN = /^\[.+ output from an earlier turn expired: \d+ characters removed; /u

/** Paragraph break that precedes a spill-policy notice appended to a retained preview. */
const NOTICE_BREAK = '\n\n('

/**
 * Split off the trailing spill-policy notice of one text block.
 * @param text - complete text of a tool-result block.
 * @returns the notice when the block ends with one, else `null`.
 */
function spillNoticeOf(text: string): string | null {
  if (!hasSpillNotice(text)) return null
  // The shortest suffix that is itself a complete notice is the notice.
  let index = text.lastIndexOf(NOTICE_BREAK)
  while (index >= 0) {
    const tail = text.slice(index + NOTICE_BREAK.length - 1)
    if (hasSpillNotice(tail)) return tail
    index = text.lastIndexOf(NOTICE_BREAK, index - 1)
  }
  return text
}

/** Turn-age based replacement of cold tool results with one-line stubs. */
export class ToolResultExpiry extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event; the projection registry maintains the tool-result surface state
  // this service reads instead of scanning event history.
  static inject = ['tokenMeter', 'sessionProjections']

  static Config: z<ToolResultExpiryConfig> = z.object({
    coldTurns: z.number().step(1).min(1).default(DEFAULTS.coldTurns),
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    sweepEvery: z.number().step(1).min(1).default(DEFAULTS.sweepEvery),
    idleSweepMs: z.number().step(1).min(1).default(DEFAULTS.idleSweepMs),
  })

  /** Resolved and immutable expiry policy. */
  readonly config: ResolvedConfig
  /** Turn of the last pass that landed a replacement, per session. */
  private readonly lastSweep = new WeakMap<Session, number>()
  /** Wall-clock time and turn of the most recent pre-step seen, per session. */
  private readonly lastStep = new WeakMap<Session, { at: number; turn: number }>()

  constructor(ctx: Context, config: ToolResultExpiryConfig = {}) {
    super(ctx, 'toolResultExpiry')
    this.config = resolveConfig(config)
    ctx.sessionProjections.register(toolResultSurfaceProjection)
    // Prepended so expiry lands before compaction-basic measures pressure in
    // its own pre-step listener; a relieved surface may then skip summarization.
    ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = this.sweepSession(agent.session, turn)
          if (result.expired.length > 0) {
            ctx.logger.info(
              `tool-result expiry (turn ${turn}): stubbed ${result.expired.length} cold tool results `
              + `(${result.charsRemoved} chars removed)`,
            )
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`tool-result expiry failed: ${message}; continuing the turn`)
        }
      }
      return next()
    }, { prepend: true })
  }

  /** Current wall-clock time in milliseconds; overridable for tests. */
  now(): number {
    return Date.now()
  }

  /**
   * Whether a pass may land replacements at `currentTurn`. Any landed
   * replacement rewrites history and invalidates the provider prompt-cache
   * prefix, so sweeps are confined to moments when that prefix is already
   * lost or stale: the session has idled past `idleSweepMs`, or `sweepEvery`
   * turns have elapsed since the last landed sweep (fallback bound).
   * Compaction-driven sweeps bypass this gate via `sweepForCompaction`.
   * @param session - session being prepared.
   * @param currentTurn - turn whose request is being prepared.
   * @returns true when expiry should run this turn.
   */
  isSweepTurn(session: Session, currentTurn: number): boolean {
    const previous = this.lastStep.get(session)
    if (previous !== undefined && this.now() - previous.at >= this.config.idleSweepMs) return true
    const last = this.lastSweep.get(session) ?? 0
    return currentTurn - last >= this.config.sweepEvery
  }

  /**
   * Record the pre-step for `currentTurn`, run `expireSession` only when
   * `isSweepTurn` allows, and note the turn when a replacement lands.
   * @param session - session whose current surface may be rewritten.
   * @param currentTurn - turn whose request is being prepared.
   * @returns the pass result, empty when skipped.
   */
  sweepSession(session: Session, currentTurn: number): ExpiryResult {
    const allowed = this.isSweepTurn(session, currentTurn)
    this.lastStep.set(session, { at: this.now(), turn: currentTurn })
    if (!allowed) return { expired: [], charsRemoved: 0 }
    const result = this.expireSession(session, currentTurn)
    if (result.expired.length > 0) this.lastSweep.set(session, currentTurn)
    return result
  }

  /**
   * Sweep on behalf of compaction, which is about to rewrite history anyway
   * so the cache cost is already sunk. Uses the turn recorded by the latest
   * pre-step; a session never stepped in this process is left untouched.
   * @param session - session compaction is about to summarize.
   * @returns the pass result, empty when no pre-step turn is known.
   */
  sweepForCompaction(session: Session): ExpiryResult {
    const step = this.lastStep.get(session)
    if (step === undefined) return { expired: [], charsRemoved: 0 }
    const result = this.expireSession(session, step.turn)
    if (result.expired.length > 0) this.lastSweep.set(session, step.turn)
    return result
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Whether a tool result produced in `resultTurn` is cold at `currentTurn`.
   * @param resultTurn - turn that produced the result.
   * @param currentTurn - turn whose request is being prepared.
   * @returns true once `coldTurns` or more turns have started since `resultTurn`.
   */
  isCold(resultTurn: number, currentTurn: number): boolean {
    return currentTurn - resultTurn >= this.config.coldTurns
  }

  /**
   * Replace all text of an over-threshold result with one stub, keeping
   * non-text blocks in their original relative order.
   * A text block ending in a spill-policy notice keeps that notice after the
   * stub, which then points at the stored file instead of a rerun.
   * @param blocks - original tool-result content.
   * @param toolName - tool that produced the result, named in the stub.
   * @returns stubbed content, or `null` when the text is within threshold,
   * already a stub, or not longer than the stub that would replace it.
   */
  expireContent(blocks: readonly ContentBlock[], toolName: string): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null
    const texts = blocks.filter(block => block.type === 'text')
    if (texts.some(block => STUB_PATTERN.test(block.text))) return null
    // A spill-policy notice is the model's only pointer to the complete
    // result on disk; keep every notice verbatim after the stub so reading
    // the stored file, not rerunning the tool, is the way back.
    const notices: string[] = []
    let noticeChars = 0
    for (const block of texts) {
      const notice = spillNoticeOf(block.text)
      if (notice === null) continue
      notices.push(notice)
      noticeChars += codePointLength(notice)
    }
    const removable = totalChars - noticeChars
    if (removable <= 0) return null
    const stubText = notices.length === 0
      ? expiredStub(toolName, removable)
      : [expiredStubWithSpill(toolName, removable), ...notices].join('\n\n')
    if (codePointLength(stubText) >= totalChars) return null

    const stub: ContentBlock = { type: 'text', text: stubText }
    const expired: ContentBlock[] = []
    let stubInserted = false
    for (const block of blocks) {
      if (block.type !== 'text') {
        expired.push(block)
        continue
      }
      if (!stubInserted) {
        expired.push(stub)
        stubInserted = true
      }
    }
    /* v8 ignore next -- removable > 0 guarantees at least one text block. */
    if (!stubInserted) throw new Error('tool-result expiry: no text block to replace')
    return expired
  }

  /**
   * Stub every cold over-threshold tool result on one stable current-surface
   * snapshot. Each replacement preserves the complete event data except for
   * `content`, cites the shadowed node so replay can recover it, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing
   * the shadowed node through the injected token meter.
   * @param session - session whose current surface is rewritten.
   * @param currentTurn - turn whose request is being prepared.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  expireSession(session: Session, currentTurn: number): ExpiryResult {
    const state = this.ctx.sessionProjections.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    const candidates: ToolResultSurfaceNode[] = state.nodes.filter(node => this.isCold(node.turn, currentTurn))
    if (candidates.length === 0) return { expired: [], charsRemoved: 0 }
    // Current derived messages carry every logged message projection (image
    // offload and the like) that the stub must preserve; identities survive
    // projection, so the node's own message id finds its projected form.
    const projected = new Map<string, Message>()
    for (const message of session.deriveMessages()) projected.set(message.id, message)

    const expired: ExpiredEntry[] = []
    let charsRemoved = 0
    for (const node of candidates) {
      const original = (projected.get(node.data.message.id) ?? node.data.message) as ToolResultMessage
      const content = this.expireContent(original.content, node.toolName)
      if (content === null) continue
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({ ...original, content })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: node.seq, end: node.seq },
        shadowedSeqs: [node.seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
      })
      const replacement = session.append('tool/result', {
        ...node.data,
        message,
      }, {
        surfaceOp: { op: 'replace', startSeq: node.seq, endSeq: node.seq },
        sourceEventSeqs: [node.seq],
      })
      expired.push({
        originalSeq: node.seq,
        replacementSeq: replacement.seq,
        callId: node.callId,
        turn: node.turn,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { expired, charsRemoved }
  }
}

export default ToolResultExpiry
