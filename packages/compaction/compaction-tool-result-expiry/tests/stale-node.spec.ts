import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, createUserMessage, freezeMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { eventLines, scanLog, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry, { toolResultSurfaceProjection } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'

const MODEL = 'test-model'
const BIG = 400

interface Harness {
  ctx: Context
  registry: SessionProjectionRegistry
  expiry: ToolResultExpiry
}

function harness(): Harness {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const expiry = new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 120 })
  return { ctx, registry, expiry }
}

/** Append one complete turn with one tool call; returns the tool/result seq. */
function appendToolTurn(session: Session, turn: number, call: string, content: ContentBlock[]): SessionSeq {
  const callId = ToolCallId(call)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

/**
 * Replace the current surface positions from `startSeq` through `endSeq` with
 * one summary message, citing the shadowed nodes in surface order, the way a
 * turn fold does.
 */
function foldRange(session: Session, startSeq: SessionSeq, endSeq: SessionSeq): SessionSeq[] {
  const nodes = session.surface.nodes
  const shadowed = nodes.slice(nodes.indexOf(startSeq), nodes.indexOf(endSeq) + 1)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'folded turns' }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [...shadowed],
  })
  return [...shadowed]
}

/** Serialize the session as a current JSONL log and read it back through the v4 reader. */
function rereadLog(session: Session): SessionEvent[] {
  const text = `${JSON.stringify(toHeaderLine(session.header))}\n${eventLines(session.snapshotEvents())}\n`
  return scanLog(Buffer.from(text)).events
}

function pruneCount(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === 'compaction/prune').length
}

describe('tool-result expiry after a positional fold over a later-seq replacement', () => {
  it('drops an expiry stub from the projection once a fold covers its surface position', () => {
    const { registry, expiry } = harness()
    const session = Session.create(SessionId('stale-stub'))
    const first = appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'r'.repeat(BIG) }])
    const later = appendToolTurn(session, 2, 'c2', [{ type: 'text', text: 'small' }])
    session.append('turn/start', { turn: 3 })
    const swept = expiry.expireSession(session, 3)
    expect(swept.expired.map(entry => entry.originalSeq)).toEqual([first])
    const stubSeq = swept.expired[0]!.replacementSeq
    // The stub sits before `later` on the surface but carries a later seq.
    expect(stubSeq).toBeGreaterThan(later)
    const head = session.surface.nodes[0]!
    expect(session.surface.nodes.indexOf(SessionSeq(stubSeq))).toBeLessThan(session.surface.nodes.indexOf(later))

    const shadowed = foldRange(session, head, later)
    expect(shadowed).toContain(stubSeq)
    expect(session.surface.nodes).not.toContain(stubSeq)

    const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    expect(state.nodes.map(node => node.seq)).not.toContain(stubSeq)
    expect(state.nodes).toEqual([])
    expect(state.surface).toEqual([...session.surface.nodes])
  })

  it('writes no orphan prune when the covered node is still over threshold, and the log rereads', () => {
    const { registry, expiry } = harness()
    const session = Session.create(SessionId('stale-orphan'))
    const first = appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'r'.repeat(BIG * 2) }])
    const later = appendToolTurn(session, 2, 'c2', [{ type: 'text', text: 'small' }])
    session.append('turn/start', { turn: 3 })
    // A model-free trimming replacement that is shorter but still over the
    // expiry threshold, appended with its shadow price like every prune.
    const original = session.deriveEventMessage(session.eventAt(first)!) as ToolResultMessage
    session.append('compaction/prune', {
      shadowedRange: { start: first, end: first },
      shadowedSeqs: [first],
      shadowedTokenCount: 1,
    })
    const trimmed = session.append('tool/result', {
      ...(session.eventAt(first) as SessionEvent<'tool/result'>).data,
      message: freezeMessage<ToolResultMessage>({ ...original, content: [{ type: 'text', text: 't'.repeat(BIG) }] }),
    }, {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: first },
      sourceEventSeqs: [first],
    }).seq
    expect(trimmed).toBeGreaterThan(later)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    foldRange(session, session.surface.nodes[0]!, later)
    expect(session.surface.nodes).not.toContain(trimmed)

    session.append('turn/start', { turn: 4 })
    const prunesBefore = pruneCount(session)
    let sweepError: unknown
    let expired: readonly unknown[] | undefined
    try {
      expired = expiry.expireSession(session, 4).expired
    } catch (error: unknown) {
      sweepError = error
    }
    // The stored log must stay readable; an orphan prune fails the v4 span check.
    expect(() => rereadLog(session)).not.toThrow()
    expect(pruneCount(session)).toBe(prunesBefore)
    expect(sweepError).toBeUndefined()
    expect(expired).toEqual([])
    const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    expect(state.nodes.map(node => node.seq)).not.toContain(trimmed)
    expect(rereadLog(session)).toHaveLength(session.snapshotEvents().length)
  })

  it('skips a projection node the session surface no longer shows instead of writing its prune', () => {
    const { ctx, registry, expiry } = harness()
    const session = Session.create(SessionId('stale-guard'))
    const first = appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'r'.repeat(BIG) }])
    const second = appendToolTurn(session, 2, 'c2', [{ type: 'text', text: 's'.repeat(BIG) }])
    session.append('turn/start', { turn: 3 })
    const real = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    const ghost = { ...real.nodes[0]!, seq: SessionSeq(9999) }
    const stateOf = vi.spyOn(registry, 'stateOf').mockReturnValue({ ...real, nodes: [ghost, ...real.nodes] })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const result = expiry.expireSession(session, 4)

    expect(stateOf).toHaveBeenCalled()
    expect(result.expired.map(entry => entry.originalSeq)).toEqual([first, second])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped seqs 9999'))
    // Every prune is immediately followed by the replacement citing the same seq.
    const events = session.snapshotEvents()
    const prunes = events.filter(event => event.type === 'compaction/prune')
    expect(prunes).toHaveLength(2)
    for (const prune of prunes) {
      const next = events[prune.seq + 1]!
      expect(next.type).toBe('tool/result')
      expect(next.sourceEventSeqs).toEqual(prune.data.shadowedSeqs)
    }
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(() => rereadLog(session)).not.toThrow()
  })
})

describe('tool-result surface projection positions', () => {
  it('keeps tool-result nodes when a fold covers only other surface nodes', () => {
    const { registry } = harness()
    const session = Session.create(SessionId('fold-non-tool'))
    const seq = appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'x' }])
    const assistant = session.surface.nodes[0]!
    foldRange(session, assistant, assistant)
    const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    expect(state.nodes.map(node => node.seq)).toEqual([seq])
    expect(state.surface).toEqual([...session.surface.nodes])
  })
})

describe('tool-result surface projection cache version', () => {
  it('discards a checkpoint row from the previous state version and refolds from the log', () => {
    expect(toolResultSurfaceProjection.stateVersion).toBe(2)
    const { registry } = harness()
    const session = Session.create(SessionId('stale-cache'))
    const seq = appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'x' }])
    const events = session.snapshotEvents()
    const stale = { toolResultSurface: { ver: 1, seq: events.at(-1)!.seq, val: { nodes: [], toolNames: {} } } }
    expect(registry.restoreFloor(stale)).toBe(0)

    const restored = registry.restore(stale, events, SessionLogOffset(0), session.header, SessionLogOffset(0))
    const row = restored.checkpoint['toolResultSurface']!
    expect(row.ver).toBe(2)
    const state = row.val as ToolResultSurfaceState
    expect(state.nodes.map(node => node.seq)).toEqual([seq])
    expect(state.surface).toEqual([...session.surface.nodes])
  })
})
