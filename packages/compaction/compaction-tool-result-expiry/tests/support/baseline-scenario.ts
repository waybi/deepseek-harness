/**
 * Fixed tool-result expiry scenario shared by the behavior-lock spec: one
 * Session with cold large text, text plus an offloaded image, small, error
 * with metadata, and multi-block emoji results, plus the normalization that
 * removes per-run values (event `seq`, `time`, random message ids) from the
 * events one expiry pass appends.
 */

import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry from '@deepseek-ai/dsh-compaction-tool-result-expiry'

const MODEL = 'test-model'

/** Image block whose occurrence the scenario offloads before expiry. */
export const IMAGE: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

/** Service, registry, and Session wired the way the host composes them. */
export interface ScenarioHost {
  ctx: Context
  registry: SessionProjectionRegistry
  expiry: ToolResultExpiry
  session: Session
}

/**
 * Compose a fresh host with the image-offload message projection installed on the Session.
 * @param id - Session identity.
 * @returns the composed host.
 */
export function scenarioHost(id: string): ScenarioHost {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const expiry = new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 120 })
  const session = Session.create(SessionId(id), undefined, undefined, undefined, [imageOffloadProjection])
  return { ctx, registry, expiry, session }
}

/**
 * Append one complete tool turn.
 * @param session - Session to extend.
 * @param turn - turn number.
 * @param call - tool call id.
 * @param content - tool-result content.
 * @param extra - optional error and metadata fields of the `tool/result` data.
 * @returns the `tool/result` seq.
 */
export function appendToolTurn(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Pick<SessionEventMap['tool/result'], 'error' | 'meta'> & { toolName?: string } = {},
): SessionSeq {
  const callId = ToolCallId(call)
  const toolName = extra.toolName ?? 'bash'
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: toolName, arguments: '{}' })
  const result = session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId, content, isError: extra.error !== undefined }),
    ...extra.error !== undefined ? { error: extra.error } : {},
    ...extra.meta !== undefined ? { meta: extra.meta } : {},
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

/**
 * Build the fixed scenario: cold results in turns 1–5 and a warm one in turn 6.
 * @param session - empty Session with the image-offload projection installed.
 */
export function buildScenario(session: Session): void {
  appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'c'.repeat(400) }], { toolName: 'read_file' })
  const withImage = appendToolTurn(session, 2, 'c2', [
    { type: 'text', text: 'x'.repeat(200) }, IMAGE, { type: 'text', text: 'y'.repeat(200) },
  ], { toolName: 'screenshot' })
  session.append('image/offload', { targets: [{ seq: withImage, imageIndexes: [0] }] })
  appendToolTurn(session, 3, 'c3', [{ type: 'text', text: 'small' }])
  appendToolTurn(session, 4, 'c4', [{ type: 'text', text: 'e'.repeat(300) }], {
    error: { name: 'Failure', code: 'EXIT_1', reason: 'exit 1' },
    meta: { kind: 'diff', lines: [1, 2, 3] },
  })
  appendToolTurn(session, 5, 'c5', [
    { type: 'text', text: '中文😀'.repeat(50) }, { type: 'reasoning', text: 'kept' }, { type: 'text', text: 'tail' },
  ])
  appendToolTurn(session, 6, 'c6', [{ type: 'text', text: 'w'.repeat(400) }])
  session.append('turn/start', { turn: 7 })
}

/**
 * Recursively sort object keys so field sets compare without depending on
 * insertion order; arrays keep their order.
 * @param value - JSON value to canonicalize.
 * @returns the same value with sorted object keys.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]))
}

/**
 * Normalize appended events for comparison across runs.
 * @param events - events appended by one expiry pass.
 * @returns the events without `seq`/`time`, with stable message ids and sorted keys.
 */
export function normalizeAppended(events: readonly SessionEvent[]): unknown[] {
  return events.map((event) => {
    const { seq: _seq, time: _time, ...rest } = event
    if (rest.type !== 'tool/result') return canonicalize(rest)
    const data = rest.data
    return canonicalize({
      ...rest,
      data: { ...data, message: { ...data.message, id: `msg:${data.message.source.callId}` } },
    })
  })
}
