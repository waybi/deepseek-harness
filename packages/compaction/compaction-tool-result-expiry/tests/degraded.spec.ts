import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection, SessionSeq as Seq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { appendToolTurn } from './support/baseline-scenario.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Test-only message projection that rewrites one tool result's text. */
    'test/text-rewrite': { target: Seq; text: string }
  }
}

/** Rewrites a target tool result's text, so its derived digest differs from the projection's. */
const textRewriteProjection: SessionMessageProjection<'test/text-rewrite'> = {
  type: 'test/text-rewrite',
  project(event, context) {
    const { target, text } = event.data
    const source = context.events[target - context.baseSeq]
    if (source?.type !== 'tool/result') throw new Error(`text-rewrite: seq ${target} is not a tool/result`)
    const base = context.messages.get(target) ?? source.data.message
    if (base.role !== 'tool') throw new Error('text-rewrite: message is not a tool result')
    return new Map([[target, freezeMessage<ToolResultMessage>({ ...base, content: [{ type: 'text', text }] })]])
  },
}

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

function stateOf(registry: SessionProjectionRegistry, session: Session): ToolResultSurfaceState {
  return registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
}

describe('expiry degradation when the derived text is unusable', () => {
  it('skips every node whose message id is missing, warns once, and still expires a normal node', () => {
    const { ctx, registry, expiry } = harness()
    const session = Session.create(SessionId('missing-ids'))
    appendToolTurn(session, 1, 'keep', [{ type: 'text', text: 'a'.repeat(400) }])
    appendToolTurn(session, 2, 'lost1', [{ type: 'text', text: 'b'.repeat(400) }])
    appendToolTurn(session, 3, 'lost2', [{ type: 'text', text: 'c'.repeat(400) }])
    session.append('turn/start', { turn: 5 })

    const real = stateOf(registry, session)
    const ghosted = real.nodes.map((node, index) => index === 1
      ? { ...node, messageId: 'missing-1' as never }
      : index === 2 ? { ...node, messageId: 'missing-2' as never } : node)
    vi.spyOn(registry, 'stateOf').mockReturnValue({ ...real, nodes: ghosted })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const before = session.snapshotEvents().length
    const result = expiry.expireSession(session, 5)
    const appended = session.snapshotEvents().slice(before)

    expect(result.expired.map(entry => entry.callId)).toEqual(['keep'])
    // One warning names both seqs and the reason; no prune exists for either skip.
    expect(warn.mock.calls.filter(call => String(call[0]).includes('message id is absent'))).toHaveLength(1)
    expect(String(warn.mock.calls.find(call => String(call[0]).includes('message id is absent'))![0]))
      .toContain(`${ghosted[1]!.seq}, ${ghosted[2]!.seq}`)
    expect(appended.filter(event => event.type === 'compaction/prune')).toHaveLength(1)
    expect(appended.filter(event => event.type === 'tool/result')).toHaveLength(1)
  })

  it('skips nodes whose rewritten text no longer matches the digest, warns once, and keeps the recorded digest', () => {
    const { ctx, registry, expiry } = harness()
    const session = Session.create(SessionId('digest-mismatch'), undefined, undefined, undefined, [
      imageOffloadProjection,
      textRewriteProjection,
    ])
    appendToolTurn(session, 1, 'keep', [{ type: 'text', text: 'a'.repeat(400) }])
    const changed = appendToolTurn(session, 2, 'changed', [{ type: 'text', text: 'b'.repeat(400) }])
    const changed2 = appendToolTurn(session, 3, 'changed2', [{ type: 'text', text: 'c'.repeat(400) }])
    session.append('test/text-rewrite', { target: changed, text: 'rewritten' })
    session.append('test/text-rewrite', { target: changed2, text: 'rewritten too' })
    session.append('turn/start', { turn: 4 })

    const before = stateOf(registry, session)
    const recorded = new Map(before.nodes.map(node => [String(node.callId), node.textHash]))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const start = session.snapshotEvents().length
    const result = expiry.expireSession(session, 4)
    const appended = session.snapshotEvents().slice(start)

    expect(result.expired.map(entry => entry.callId)).toEqual(['keep'])
    expect(warn.mock.calls.filter(call => String(call[0]).includes('no longer matches'))).toHaveLength(1)
    expect(appended.filter(event => event.type === 'compaction/prune')).toHaveLength(1)
    // No prune targets either skipped node.
    const pruned = appended.filter(event => event.type === 'compaction/prune')
    for (const prune of pruned) {
      expect(prune.type === 'compaction/prune' && prune.data.shadowedSeqs).not.toContain(changed)
      expect(prune.type === 'compaction/prune' && prune.data.shadowedSeqs).not.toContain(changed2)
    }
    // Expiry reads the digest and never writes it back onto the skipped nodes.
    const after = stateOf(registry, session)
    for (const callId of ['changed', 'changed2']) {
      const node = after.nodes.find(item => String(item.callId) === callId)!
      expect(node.textHash).toBe(recorded.get(callId))
    }
  })

  it('still expires a result whose image changed but whose text did not', () => {
    const { ctx, expiry } = harness()
    const session = Session.create(SessionId('image-only'), undefined, undefined, undefined, [imageOffloadProjection])
    const seq = appendToolTurn(session, 1, 'shot', [
      { type: 'text', text: 'i'.repeat(400) },
      {
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'d'.repeat(64)}` as never,
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      },
    ])
    session.append('image/offload', { targets: [{ seq, imageIndexes: [0] }] })
    session.append('turn/start', { turn: 3 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const result = expiry.expireSession(session, 3)
    expect(result.expired.map(entry => entry.callId)).toEqual(['shot'])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no longer matches'))
    // The offloaded image survives the replacement.
    const replacement = session.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    expect((replacement as Extract<typeof replacement, { type: 'tool/result' }>).data.message.content)
      .toContainEqual(expect.objectContaining({ type: 'image', offloaded: true }))
  })

  it('records that an already-stubbed result is not expired again', () => {
    const { expiry } = harness()
    const session = Session.create(SessionId('already-stub'))
    appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'x'.repeat(400) }])
    session.append('turn/start', { turn: 3 })
    expect(expiry.expireSession(session, 3).expired).toHaveLength(1)
    expect(expiry.expireSession(session, 3).expired).toEqual([])
  })
})
