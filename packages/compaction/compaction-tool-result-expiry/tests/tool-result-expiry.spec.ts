import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { formatSpillNotice, hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry, {
  codePointLength,
  DEFAULTS,
  expiredStub,
  expiredStubWithSpill,
  resolveConfig,
  toolResultSurfaceProjection,
  UNNAMED_TOOL,
} from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultExpiryConfig } from '@deepseek-ai/dsh-compaction-tool-result-expiry'

const MODEL = 'test-model'
const SMALL: ToolResultExpiryConfig = { coldTurns: 2, thresholdChars: 120 }
/** Over `SMALL.thresholdChars` and longer than any stub, so expiry is a real reduction. */
const BIG = 400

function service(config: ToolResultExpiryConfig = SMALL): ToolResultExpiry {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ToolResultExpiry(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  toolName = 'bash',
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }],
      source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: toolName, arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

function derivedMessage(session: Session, seq: number): Message {
  const message = session.deriveEventMessage(session.eventAt(SessionSeq(seq))!)
  if (message === null) throw new Error(`seq ${seq} derives no message`)
  return message
}

function derivedText(session: Session, seq: number): string {
  return derivedMessage(session, seq).content
    .map(block => (block.type === 'text' ? block.text : `<${block.type}>`))
    .join('')
}

describe('tool-result expiry configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { coldTurns: 5, thresholdChars: 100 }
    const resolved = resolveConfig(raw)
    raw.coldTurns = 1
    expect(resolved).toEqual({ coldTurns: 5, thresholdChars: 100, sweepEvery: DEFAULTS.sweepEvery, idleSweepMs: DEFAULTS.idleSweepMs })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolveConfig({ coldTurns: 1 })).toEqual({
      coldTurns: 1,
      thresholdChars: DEFAULTS.thresholdChars,
      sweepEvery: DEFAULTS.sweepEvery,
      idleSweepMs: DEFAULTS.idleSweepMs,
    })
    expect(DEFAULTS).toEqual({ coldTurns: 3, thresholdChars: 2048, sweepEvery: 30, idleSweepMs: 3_600_000 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys and invalid scalars', () => {
    const bad = [
      [{ coldTurns: 0 }, /coldTurns .* positive integer/],
      [{ coldTurns: 1.5 }, /coldTurns .* positive integer/],
      [{ thresholdChars: -1 }, /thresholdChars .* positive integer/],
      [{ headChars: 10 }, /unknown key "headChars"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultExpiryConfig)).toThrow(pattern)
    }
  })

  it('names the tool and removed size in the stub', () => {
    expect(expiredStub('read_file', 4321)).toBe(
      '[read_file output from an earlier turn expired: 4321 characters removed; rerun the tool to see it again]',
    )
  })
})

describe('ToolResultExpiry content transform', () => {
  it('measures text code points only and keeps content within threshold', () => {
    const expiry = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(expiry.measureContent(blocks)).toBe(3)
    expect(expiry.expireContent(blocks, 'bash')).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('collapses all text into one stub and keeps non-text blocks in order', () => {
    const expiry = service()
    const image = { type: 'image', attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } } satisfies ContentBlock
    const result = expiry.expireContent([
      { type: 'text', text: 'x'.repeat(200) },
      image,
      { type: 'text', text: 'y'.repeat(200) },
    ], 'screenshot')
    expect(result).toEqual([
      { type: 'text', text: expiredStub('screenshot', 400) },
      image,
    ])
  })

  it('never rewrites a stub it already emitted, nor text a stub would not shorten', () => {
    const expiry = service({ coldTurns: 2, thresholdChars: 20 })
    const stub = expiredStub('bash', 9999)
    expect(codePointLength(stub)).toBeGreaterThan(20)
    expect(expiry.expireContent([{ type: 'text', text: stub }], 'bash')).toBeNull()
    expect(expiry.expireContent([{ type: 'text', text: 'q'.repeat(40) }], 'bash')).toBeNull()
    expect(expiry.expireContent([{ type: 'text', text: 'q'.repeat(400) }], 'bash')).not.toBeNull()
  })

  it('judges coldness by turns started since the result', () => {
    const expiry = service({ coldTurns: 3 })
    expect(expiry.isCold(1, 3)).toBe(false)
    expect(expiry.isCold(1, 4)).toBe(true)
    expect(expiry.isCold(4, 4)).toBe(false)
  })
})

describe('ToolResultExpiry surface replacement', () => {
  it('stubs only cold over-threshold results, prices each, and keeps originals replayable', () => {
    const session = Session.create(SessionId('expire'))
    const cold = appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'c'.repeat(BIG) }], 'read_file')
    const coldSmall = appendToolStep(session, 2, 'c2', [{ type: 'text', text: 'small' }])
    const warm = appendToolStep(session, 3, 'c3', [{ type: 'text', text: 'w'.repeat(BIG) }])
    const before = session.snapshotEvents().length

    const result = service().expireSession(session, 4)

    expect(result.expired).toHaveLength(1)
    expect(result.expired[0]).toMatchObject({
      originalSeq: cold, callId: ToolCallId('c1'), turn: 1, charsBefore: BIG,
    })
    expect(result.charsRemoved).toBe(BIG - codePointLength(expiredStub('read_file', BIG)))
    expect(derivedText(session, result.expired[0]!.replacementSeq)).toBe(expiredStub('read_file', BIG))
    expect(derivedText(session, coldSmall)).toBe('small')
    expect(derivedText(session, warm)).toBe('w'.repeat(BIG))
    // Original stays verbatim in the log; surface points at the stub.
    expect(derivedText(session, cold)).toBe('c'.repeat(BIG))
    expect(session.surface.nodes).not.toContain(SessionSeq(cold))
    expect(session.surface.nodes).toContain(SessionSeq(result.expired[0]!.replacementSeq))

    const appended = session.snapshotEvents().slice(before)
    expect(appended.map(event => event.type)).toEqual(['compaction/prune', 'tool/result'])
    const prune = appended[0]!
    expect(prune.type === 'compaction/prune' && prune.data).toMatchObject({
      shadowedRange: { start: cold, end: cold },
      shadowedSeqs: [cold],
      shadowedTokenCount: METER.estimateMessage(derivedMessage(session, cold)),
    })
    expect(appended[1]!.sourceEventSeqs).toEqual([cold])
  })

  it('is idempotent across requests and expires newly cold results as turns advance', () => {
    const session = Session.create(SessionId('expire-advance'))
    appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'c'.repeat(BIG) }])
    const second = appendToolStep(session, 2, 'c2', [{ type: 'text', text: 'd'.repeat(BIG) }])
    const expiry = service()
    expect(expiry.expireSession(session, 3).expired.map(entry => entry.turn)).toEqual([1])
    expect(expiry.expireSession(session, 3).expired).toEqual([])
    const later = expiry.expireSession(session, 4)
    expect(later.expired.map(entry => entry.originalSeq)).toEqual([second])
    expect(expiry.expireSession(session, 4).expired).toEqual([])
  })

  it('sweeps on the first eligible turn, then holds the prefix for sweepEvery turns', () => {
    const session = Session.create(SessionId('expire-sweep'))
    appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'c'.repeat(BIG) }])
    const expiry = service({ ...SMALL, sweepEvery: 3 })
    // Turn 2: cold candidates absent (coldTurns 2) -> nothing lands, no sweep recorded.
    expect(expiry.sweepSession(session, 2).expired).toEqual([])
    expect(expiry.isSweepTurn(session, 3)).toBe(true)
    // Turn 3: first landed sweep.
    expect(expiry.sweepSession(session, 3).expired.map(entry => entry.turn)).toEqual([1])
    const second = appendToolStep(session, 3, 'c2', [{ type: 'text', text: 'd'.repeat(BIG) }])
    // Turns 4, 5: c2 is cold from turn 5 but the sweep is held until turn 6.
    expect(expiry.isSweepTurn(session, 4)).toBe(false)
    expect(expiry.sweepSession(session, 5).expired).toEqual([])
    expect(derivedText(session, second)).toBe('d'.repeat(BIG))
    // Turn 6: sweep reopens and lands the batch.
    expect(expiry.isSweepTurn(session, 6)).toBe(true)
    expect(expiry.sweepSession(session, 6).expired.map(entry => entry.originalSeq)).toEqual([second])
    expect(expiry.isSweepTurn(session, 7)).toBe(false)
  })

  it('keeps a spill-policy notice after the stub and points the model at the stored file', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 9000 }, {
      locator: SpillLocator('/tmp/spill/result.txt'),
      retrievalHint: 'Use read to retrieve the complete output',
    })
    const preview = 'p'.repeat(BIG)
    const session = Session.create(SessionId('expire-spill'))
    const spilled = appendToolStep(session, 1, 'c1', [{ type: 'text', text: `${preview}\n\n${notice}` }])
    const expiry = service({ ...SMALL, sweepEvery: 1 })

    const result = expiry.sweepSession(session, 3)
    expect(result.expired.map(entry => entry.originalSeq)).toEqual([spilled])
    const text = derivedText(session, result.expired[0]!.replacementSeq)
    expect(text).toBe(`${expiredStubWithSpill('bash', codePointLength(preview) + 2)}\n\n${notice}`)
    expect(text).toContain('/tmp/spill/result.txt')
    expect(hasSpillNotice(text)).toBe(true)
    // The stubbed result is recognized as already expired on the next sweep.
    expect(expiry.expireSession(session, 5).expired).toEqual([])
  })

  it('leaves a notice-only result alone because nothing but the pointer would be removed', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 9000 }, {
      locator: SpillLocator('/tmp/spill/' + 'x'.repeat(BIG)),
      retrievalHint: 'Use read to retrieve the complete output',
    })
    const session = Session.create(SessionId('expire-spill-only'))
    const seq = appendToolStep(session, 1, 'c1', [{ type: 'text', text: notice }])
    expect(service({ ...SMALL, sweepEvery: 1 }).sweepSession(session, 3).expired).toEqual([])
    expect(derivedText(session, seq)).toBe(notice)
  })

  it('sweeps every turn when sweepEvery is 1', () => {
    const session = Session.create(SessionId('expire-sweep-1'))
    appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'c'.repeat(BIG) }])
    const second = appendToolStep(session, 2, 'c2', [{ type: 'text', text: 'd'.repeat(BIG) }])
    const expiry = service({ ...SMALL, sweepEvery: 1 })
    expect(expiry.sweepSession(session, 3).expired.map(entry => entry.turn)).toEqual([1])
    expect(expiry.sweepSession(session, 4).expired.map(entry => entry.originalSeq)).toEqual([second])
  })

  it('falls back to a generic tool name when no surface assistant message names the call', () => {
    const session = Session.create(SessionId('expire-nameless'))
    const callId = ToolCallId('orphan')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'calling without a visible tool-call block' }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    const seq = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'z'.repeat(BIG) }], isError: false }),
    }, { surfaceOp: 'append' }).seq
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const result = service().expireSession(session, 3)
    expect(result.expired).toHaveLength(1)
    expect(result.expired[0]!.originalSeq).toBe(seq)
    expect(derivedText(session, result.expired[0]!.replacementSeq)).toBe(expiredStub(UNNAMED_TOOL, BIG))
  })

})

describe('tool-result surface projection', () => {
  const { init, apply } = toolResultSurfaceProjection

  it('returns the same reference for events that touch neither nodes nor names', () => {
    const session = Session.create(SessionId('proj-noop'))
    const state = init()
    session.append('turn/start', { turn: 1 })
    const [turnStart] = session.snapshotEvents()
    expect(turnStart).toBeDefined()
    expect(apply(state, turnStart!)).toBe(state)
  })

  it('tracks appends, names calls from assistant blocks, and keeps replacement position', () => {
    const session = Session.create(SessionId('proj-fold'))
    const first = appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'a'.repeat(BIG) }], 'read_file')
    const second = appendToolStep(session, 2, 'c2', [{ type: 'text', text: 'b' }], 'bash')
    let state = init()
    for (const event of session.snapshotEvents()) state = apply(state, event)
    expect(state.nodes.map(node => [node.seq, node.turn, node.toolName])).toEqual([
      [first, 1, 'read_file'],
      [second, 2, 'bash'],
    ])
    expect(state.toolNames).toEqual({ c1: 'read_file', c2: 'bash' })

    session.append('turn/start', { turn: 3 })
    const before = session.snapshotEvents().length
    const result = service().expireSession(session, 3)
    expect(result.expired.map(entry => entry.originalSeq)).toEqual([first])
    for (const event of session.snapshotEvents().slice(before)) state = apply(state, event)
    // The stub takes the first node's position; the untouched later node keeps its lower seq after it.
    expect(state.nodes.map(node => node.seq)).toEqual([result.expired[0]!.replacementSeq, second])
    expect(state.nodes[0]!.toolName).toBe('read_file')
    expect(state.nodes[0]!.turn).toBe(1)
  })

  it('exposes the same state through the registry the service reads', () => {
    const ctx = new Context()
    const registry = new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new ToolResultExpiry(ctx, SMALL)
    const session = Session.create(SessionId('proj-registry'))
    const seq = appendToolStep(session, 1, 'c1', [{ type: 'text', text: 'x' }])
    const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    expect(state.nodes.map(node => node.seq)).toEqual([seq])
  })
})
