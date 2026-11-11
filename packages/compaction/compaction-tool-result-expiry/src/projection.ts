/**
 * Host-only session projection of the current tool-result surface nodes:
 * everything expiry needs about each candidate, maintained incrementally from
 * committed surface events so the service never reads event history.
 *
 * A node keeps the result message id, the `tool/result` data fields other
 * than `message`, and a digest of the message text, not the message content.
 * The complete content is not required state: the Session derives it from
 * its log through `deriveMessages()`, and expiry reads it there.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-expiry/projection
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { codePointLength } from './config.ts'

/**
 * Code points of result text kept in each node's `summary`. The value is
 * part of the persisted state fields, so changing it requires a
 * `stateVersion` bump; it is a format constant, not a deployment setting.
 * 256 code points identify a result in a cache dump while keeping a node
 * under about 1 KiB of JSON regardless of the result size.
 */
export const SUMMARY_CODE_POINTS = 256

/** Text digest of one tool-result message. */
export interface ToolResultTextDigest {
  /** First `SUMMARY_CODE_POINTS` code points of the concatenated text blocks. */
  readonly summary: string
  /** Code points across all text blocks, without separators; equals `ToolResultExpiry.measureContent`. */
  readonly textChars: number
  /** First 16 hex digits of the SHA-256 of the UTF-8 JSON array of text-block strings. */
  readonly textHash: string
}

/**
 * Digest the text blocks of tool-result content, in content order. Non-text
 * blocks are excluded, so an image-offload projection that only marks images
 * keeps the digest. The hash input is the JSON array of block texts, so
 * different block splits of the same characters produce different hashes.
 * @param blocks - tool-result message content.
 * @returns the summary, code-point count, and hash; empty text yields `''`, 0, and the hash of `[]`.
 */
export function digestToolResultText(blocks: readonly ContentBlock[]): ToolResultTextDigest {
  const texts: string[] = []
  let textChars = 0
  let summary = ''
  let summaryChars = 0
  for (const block of blocks) {
    if (block.type !== 'text') continue
    texts.push(block.text)
    textChars += codePointLength(block.text)
    if (summaryChars === SUMMARY_CODE_POINTS) continue
    for (const char of block.text) {
      summary += char
      summaryChars += 1
      if (summaryChars === SUMMARY_CODE_POINTS) break
    }
  }
  const textHash = createHash('sha256').update(JSON.stringify(texts), 'utf8').digest('hex').slice(0, 16)
  return { summary, textChars, textHash }
}

/** One current tool-result surface node as expiry sees it. */
export interface ToolResultSurfaceNode {
  /** Surface node seq; the seq a replacement must cite. */
  readonly seq: SessionSeq
  /** Turn that produced the result. */
  readonly turn: number
  /** Tool call the result answers. */
  readonly callId: ToolCallId
  /** Tool named by the assistant `tool-call` block that issued the call, or `tool` when none is on the surface. */
  readonly toolName: string
  /** Id of the result message; expiry finds the current content among the Session's derived messages by it. */
  readonly messageId: MessageId
  /** The node's `tool/result` data except `message`, re-appended verbatim by a replacement. */
  readonly fields: Omit<SessionEvent<'tool/result'>['data'], 'message'>
  /** First `SUMMARY_CODE_POINTS` code points of the message text. */
  readonly summary: string
  /** Code points across the message text blocks. */
  readonly textChars: number
  /** Text hash from `digestToolResultText`; expiry skips the node when the derived message text hashes differently. */
  readonly textHash: string
}

/**
 * Projected state: every current surface node seq in surface order, the
 * current tool-result nodes in that order, and the call-id → tool-name map.
 * A replacement shadows the surface positions from `startSeq` through
 * `endSeq`, so coverage is decided by position in `surface`, never by seq
 * magnitude: a replacement node carries a later seq than untouched nodes
 * after it. Plain JSON for the persisted projection cache; the fold never
 * mutates a state it received.
 */
export interface ToolResultSurfaceState {
  surface: SessionSeq[]
  nodes: ToolResultSurfaceNode[]
  toolNames: Record<string, string>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Current tool-result surface nodes for turn-age expiry. */
    toolResultSurface: ToolResultSurfaceState
  }
}

const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const turnNumber = z.number().int().positive()

/**
 * Plain-JSON checkpoint of the retained tool-result surface. `fields` is the
 * logged `tool/result` payload without `message`; the stub replacement
 * re-appends it unchanged, so it is kept opaque here and trusted from the
 * durable log it was copied from.
 */
const stateSchema = z.object({
  surface: z.array(sessionSeq),
  nodes: z.array(z.object({
    seq: sessionSeq,
    turn: turnNumber,
    callId: z.string().transform(ToolCallId),
    toolName: z.string(),
    messageId: z.string().transform(MessageId),
    fields: z.custom<Omit<SessionEvent<'tool/result'>['data'], 'message'>>(
      value => typeof value === 'object' && value !== null && !Array.isArray(value) && !('message' in value),
      'tool/result fields must be an object without message',
    ),
    summary: z.string(),
    textChars: z.number().int().nonnegative(),
    textHash: z.string().regex(/^[0-9a-f]{16}$/u),
  }).strict()),
  toolNames: z.record(z.string(), z.string()),
}).strict()

/** Generic tool name used when no surface assistant message names the call. */
export const UNNAMED_TOOL = 'tool'

/**
 * Fold one committed event into the tool-result surface state. Returns the
 * same reference for non-surface events; every surface event changes
 * `surface`.
 */
function fold(state: ToolResultSurfaceState, event: SessionEvent): ToolResultSurfaceState {
  if (!isSurfaceEvent(event)) return state

  let toolNames = state.toolNames
  if (event.type === 'assistant/message') {
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call' && toolNames[block.id] !== block.name) {
        toolNames = { ...toolNames, [block.id]: block.name }
      }
    }
  }

  const op = event.surfaceOp
  let surface: SessionSeq[]
  let nodes = state.nodes
  let replacement: ToolResultSurfaceNode | undefined
  if (event.type === 'tool/result') {
    const { message, ...fields } = event.data
    const callId = message.source.callId
    replacement = {
      seq: event.seq,
      turn: event.data.turn,
      callId,
      toolName: toolNames[callId] ?? UNNAMED_TOOL,
      messageId: message.id,
      fields,
      ...digestToolResultText(message.content),
    }
  }
  if (op === 'append') {
    surface = [...state.surface, event.seq]
    if (replacement !== undefined) nodes = [...nodes, replacement]
  } else {
    // Committed events passed Session surface validation, so both ends are
    // current surface nodes with start at or before end.
    const startIdx = state.surface.indexOf(op.startSeq)
    const endIdx = state.surface.indexOf(op.endSeq)
    /* v8 ignore next 3 -- Session rejects a replace whose range is not on the current surface. */
    if (startIdx === -1 || endIdx < startIdx) {
      throw new Error(`tool-result surface: replacement at seq ${event.seq} names no current surface span`)
    }
    const shadowed = new Set(state.surface.slice(startIdx, endIdx + 1))
    surface = [...state.surface.slice(0, startIdx), event.seq, ...state.surface.slice(endIdx + 1)]
    const first = nodes.findIndex(node => shadowed.has(node.seq))
    if (first !== -1) {
      const kept = nodes.filter(node => !shadowed.has(node.seq))
      nodes = replacement === undefined
        ? kept
        : [...kept.slice(0, first), replacement, ...kept.slice(first)]
    } else if (replacement !== undefined) {
      /* v8 ignore next 2 -- Session rejects a tool/result replacement whose target is not a current tool/result. */
      throw new Error(`tool-result surface: replacement at seq ${event.seq} shadows no current tool-result node`)
    }
  }
  return { surface, nodes, toolNames }
}

/**
 * Host-only projection definition registered by `ToolResultExpiry`. A
 * checkpoint row of another `stateVersion` is discarded and the state is
 * refolded from the log; version 3 replaced the complete `data` with
 * `messageId`, `fields`, and the text digest.
 */
export const toolResultSurfaceProjection = {
  key: 'toolResultSurface',
  stateVersion: 3,
  stateSchema,
  init: (): ToolResultSurfaceState => ({ surface: [], nodes: [], toolNames: {} }),
  apply: fold,
} satisfies Omit<ProjectionDefinition<'toolResultSurface', ToolResultSurfaceState>, 'wire'>
