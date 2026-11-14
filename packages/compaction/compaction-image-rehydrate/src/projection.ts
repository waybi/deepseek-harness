/**
 * Two pure folds for round-age image hydration, both replay-safe.
 *
 * The surface index folds every committed event into `turn/start`-scoped
 * message nodes, so a pass decides from projection state and never reads event
 * history. The `image/rehydrate` message projection rewrites the request-face
 * content of the messages one durable decision names; the durable `user/message`
 * and `tool/result` events keep their images.
 *
 * @module @deepseek-ai/dsh-compaction-image-rehydrate/projection
 */

import { z } from 'zod'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { imagePlaceholder } from './config.ts'
import type { ImageRehydrateTarget } from './types.ts'

/** One current message node as hydration sees it. */
export interface ImageSurfaceNode {
  /** Surface node sequence; the seq a decision cites. */
  readonly seq: SessionSeq
  /** Id of the node's message; a pass finds its current content among derived messages by it. */
  readonly messageId: MessageId
  /** Turn that produced the message. */
  readonly turn: number
}

/**
 * Projected state: the latest turn opened in the log and every current
 * image-capable message node in surface order. Plain JSON for the persisted
 * projection cache; the fold never mutates a state it received.
 */
export interface ImageSurfaceState {
  /** Turn of the most recent `turn/start`; `0` before the first turn opens. */
  turn: number
  nodes: ImageSurfaceNode[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Current image-capable message nodes for round-age hydration. */
    imageSurface: ImageSurfaceState
  }
}

const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const turnNumber = z.number().int().nonnegative()

const stateSchema = z.object({
  turn: turnNumber,
  nodes: z.array(z.object({
    seq: sessionSeq,
    messageId: z.string().transform(MessageId),
    turn: turnNumber,
  }).strict()),
}).strict()

/** The one node a surface event contributes, when it carries model images. */
function nodeOf(state: ImageSurfaceState, event: SessionEvent): ImageSurfaceNode | undefined {
  if (event.type === 'user/message') return { seq: event.seq, messageId: event.data.id, turn: state.turn }
  if (event.type === 'tool/result') return { seq: event.seq, messageId: event.data.message.id, turn: event.data.turn }
  return undefined
}

/**
 * Fold one committed event into the image surface index. Returns the same
 * reference for every event that changes neither the latest turn nor a
 * tracked node.
 * @param state - state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when the event is not relevant.
 */
function fold(state: ImageSurfaceState, event: SessionEvent): ImageSurfaceState {
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn }
  if (!isSurfaceEvent(event)) return state
  const node = nodeOf(state, event)
  const op = event.surfaceOp
  if (op === 'append') return node === undefined ? state : { ...state, nodes: [...state.nodes, node] }
  // A replacement node always carries the newest seq, so dropping by seq range
  // finds exactly the shadowed nodes whatever their surface positions were.
  const kept = state.nodes.filter(entry => entry.seq < op.startSeq || entry.seq > op.endSeq)
  return { ...state, nodes: node === undefined ? kept : [...kept, node] }
}

/**
 * Host-only projection definition registered by `ImageRehydrate`. It indexes
 * the current image-capable nodes and the latest turn; the request-face
 * rewrite belongs to {@link imageRehydrateProjection}.
 */
export const imageSurfaceProjection = {
  key: 'imageSurface',
  stateVersion: 1,
  stateSchema,
  init: (): ImageSurfaceState => ({ turn: 0, nodes: [] }),
  apply: fold,
} satisfies Omit<ProjectionDefinition<'imageSurface', ImageSurfaceState>, 'wire'>

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Apply one decision to one message: every named occurrence becomes a text
 * placeholder, every other block keeps its position. The message identity is
 * preserved and the returned message is immutable.
 * @param message - message as projected by earlier decisions.
 * @param seq - the message's surface node, named in failure reports.
 * @param images - strictly increasing occurrence indexes and their stored paths.
 * @returns the rewritten immutable message.
 * @throws when a named occurrence is missing, is not an image, or is already offloaded.
 */
export function rehydrateMessageImages(
  message: Message,
  seq: SessionSeq,
  images: readonly { imageIndex: number; path: string }[],
): Message {
  let imageIndex = 0
  let selected = 0
  const content: ContentBlock[] = []
  let changed = false
  for (const block of message.content) {
    if (block.type === 'image') {
      const next = images[selected]
      if (next !== undefined && next.imageIndex === imageIndex) {
        if (block.offloaded === true) {
          throw new Error(`image/rehydrate: image index ${imageIndex} at seq ${seq} is already offloaded`)
        }
        content.push({ type: 'text', text: imagePlaceholder(block.attachment, next.path) })
        selected += 1
        changed = true
        imageIndex += 1
        continue
      }
      imageIndex += 1
    }
    content.push(block)
  }
  if (selected !== images.length) {
    throw new Error(`image/rehydrate: image index ${images[selected]?.imageIndex ?? '?'} does not exist at seq ${seq}`)
  }
  return changed ? freezeMessage({ ...message, content }) : message
}

/** Atomic validation and reconstruction of one durable hydration decision. */
export const imageRehydrateProjection: SessionMessageProjection<'image/rehydrate'> = {
  type: 'image/rehydrate',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data['targets']) || data['targets'].length === 0) {
      throw new Error('image/rehydrate: data must contain a nonempty targets array')
    }
    const messages = new Map<SessionSeq, Message>()
    const nodes = new Set(context.nodes)
    for (const target of data['targets'] as unknown[]) {
      if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target['seq']) || !Array.isArray(target['images'])) {
        throw new Error('image/rehydrate: each target must contain a seq and an images array')
      }
      const seq = SessionSeq(target['seq'])
      if (target['images'].length === 0) throw new Error(`image/rehydrate: target seq ${seq} names no images`)
      if (messages.has(seq)) throw new Error(`image/rehydrate: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`image/rehydrate: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/rehydrate: target seq ${seq} must be user/message or tool/result`)
      }
      const images: ImageRehydrateTarget['images'] = []
      let previous = -1
      for (const image of target['images'] as unknown[]) {
        if (!isRecord(image) || Object.keys(image).length !== 2 || !isIndex(image['imageIndex'])
          || typeof image['path'] !== 'string' || image['path'].length === 0) {
          throw new Error('image/rehydrate: each image must contain an imageIndex and a nonempty path')
        }
        if (image['imageIndex'] <= previous) {
          throw new Error('image/rehydrate: imageIndex must strictly increase within a target')
        }
        previous = image['imageIndex']
        images.push({ imageIndex: image['imageIndex'], path: image['path'] })
      }
      const message = context.messages.get(seq)
        ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, rehydrateMessageImages(message, seq, images))
    }
    return messages
  },
}
