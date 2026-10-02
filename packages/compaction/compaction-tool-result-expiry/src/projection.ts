/**
 * Host-only session projection of the current tool-result surface nodes:
 * everything expiry needs about each candidate, maintained incrementally from
 * committed surface events so the service never reads event history.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-expiry/projection
 */

import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

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
  /** Complete `tool/result` event data at this node, including the message content. */
  readonly data: SessionEvent<'tool/result'>['data']
}

/**
 * Projected state: current tool-result nodes in surface order plus the
 * call-id → tool-name map. Plain JSON for the persisted projection cache;
 * the fold never mutates a state it received.
 */
export interface ToolResultSurfaceState {
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
 * Plain-JSON checkpoint of the retained tool-result surface. `data` is the
 * logged `tool/result` payload verbatim; the stub replacement re-appends it
 * with only `message.content` changed, so it is kept opaque here and trusted
 * from the durable log it was copied from.
 */
const stateSchema = z.object({
  nodes: z.array(z.object({
    seq: sessionSeq,
    turn: turnNumber,
    callId: z.string().transform(ToolCallId),
    toolName: z.string(),
    data: z.custom<SessionEvent<'tool/result'>['data']>(
      value => typeof value === 'object' && value !== null && !Array.isArray(value),
      'tool/result event data must be an object',
    ),
  }).strict()),
  toolNames: z.record(z.string(), z.string()),
}).strict()

/** Generic tool name used when no surface assistant message names the call. */
export const UNNAMED_TOOL = 'tool'

/**
 * Fold one committed event into the tool-result surface state. Returns the
 * same reference for events that change neither the node set nor the names.
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
  let nodes = state.nodes
  let replacement: ToolResultSurfaceNode | undefined
  if (event.type === 'tool/result') {
    const callId = event.data.message.source.callId
    replacement = {
      seq: event.seq,
      turn: event.data.turn,
      callId,
      toolName: toolNames[callId] ?? UNNAMED_TOOL,
      data: event.data,
    }
  }
  if (op === 'append') {
    if (replacement !== undefined) nodes = [...nodes, replacement]
  } else {
    // A replacement takes the surface position of the shadowed range. Order
    // is tracked positionally, not by seq: an earlier replacement node carries
    // a later seq than untouched nodes after it.
    const inRange = (node: ToolResultSurfaceNode): boolean => node.seq >= op.startSeq && node.seq <= op.endSeq
    const first = nodes.findIndex(inRange)
    if (first !== -1) {
      const kept = nodes.filter(node => !inRange(node))
      nodes = replacement === undefined
        ? kept
        : [...kept.slice(0, first), replacement, ...kept.slice(first)]
    } else if (replacement !== undefined) {
      /* v8 ignore next 2 -- Session rejects a tool/result replacement whose target is not a current tool/result. */
      throw new Error(`tool-result surface: replacement at seq ${event.seq} shadows no current tool-result node`)
    }
  }
  if (nodes === state.nodes && toolNames === state.toolNames) return state
  return { nodes, toolNames }
}

/** Host-only projection definition registered by `ToolResultExpiry`. */
export const toolResultSurfaceProjection = {
  key: 'toolResultSurface',
  stateVersion: 1,
  stateSchema,
  init: (): ToolResultSurfaceState => ({ nodes: [], toolNames: {} }),
  apply: fold,
} satisfies Omit<ProjectionDefinition<'toolResultSurface', ToolResultSurfaceState>, 'wire'>
