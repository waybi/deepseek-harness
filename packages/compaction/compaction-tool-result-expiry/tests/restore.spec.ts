import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry, {
  digestToolResultText,
  SUMMARY_CODE_POINTS,
  toolResultSurfaceProjection,
} from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { appendToolTurn } from './support/baseline-scenario.ts'

interface RestoreHarness {
  registry: SessionProjectionRegistry
  expiry: ToolResultExpiry
}

function harness(): RestoreHarness {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const expiry = new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 120 })
  return { registry, expiry }
}

/** Fold the log from init at a cut, the "no cache" answer. */
function fromZero(
  registry: SessionProjectionRegistry,
  events: readonly SessionEvent[],
  header: SessionHeader,
): ToolResultSurfaceState {
  return registry.restore({}, events, SessionLogOffset(0), header, SessionLogOffset(0))
    .checkpoint['toolResultSurface']!.val as ToolResultSurfaceState
}

/** Build one old-version row carrying complete `data`, as version 2 wrote it. */
function legacyRow(events: readonly SessionEvent[], state: ToolResultSurfaceState): ProjectionCheckpoint {
  const withData = state.nodes.map((node) => {
    const source = events[node.seq]!
    if (source.type !== 'tool/result') throw new Error(`seq ${node.seq} is not a tool/result`)
    return {
      seq: node.seq,
      turn: node.turn,
      callId: node.callId,
      toolName: node.toolName,
      data: source.data,
    }
  })
  return {
    toolResultSurface: {
      ver: 2,
      seq: events.at(-1)!.seq,
      val: { surface: [...state.surface], nodes: withData, toolNames: { ...state.toolNames } },
    },
  }
}

describe('tool-result surface projection cache version', () => {
  it('discards a ver=2 row with complete data and refolds to the no-cache state', () => {
    expect(toolResultSurfaceProjection.stateVersion).toBe(3)
    const { registry } = harness()
    const session = Session.create(SessionId('stale-cache-v2'))
    appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'x'.repeat(400) }])
    appendToolTurn(session, 2, 'c2', [{ type: 'text', text: 'y'.repeat(200) }])
    const events = session.snapshotEvents()
    const zero = fromZero(registry, events, session.header)
    const stale = legacyRow(events, zero)

    // A mismatched row pulls the restore floor to 0 so the full log refolds.
    expect(registry.restoreFloor(stale)).toBe(0)
    const restored = registry.restore(stale, events, SessionLogOffset(0), session.header, SessionLogOffset(0))
    const row = restored.checkpoint['toolResultSurface']!
    expect(row.ver).toBe(3)
    expect(row.val).toEqual(zero)
    const restoredState = row.val as ToolResultSurfaceState
    expect(restoredState.nodes).toHaveLength(2)
    for (const node of restoredState.nodes) {
      expect(node).not.toHaveProperty('data')
      expect(node.messageId).toBeDefined()
      expect(node.summary.length).toBeLessThanOrEqual(SUMMARY_CODE_POINTS)
    }
  })

  it('seeds a matching ver=3 row and replays only the tail', () => {
    const { registry } = harness()
    const session = Session.create(SessionId('seed-v3'))
    appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'a'.repeat(400) }])
    const cutEvents = session.snapshotEvents()
    const cut = fromZero(registry, cutEvents, session.header)
    const checkpoint: ProjectionCheckpoint = {
      toolResultSurface: { ver: 3, seq: cutEvents.at(-1)!.seq, val: cut },
    }
    appendToolTurn(session, 2, 'c2', [{ type: 'text', text: 'b'.repeat(400) }])
    const full = session.snapshotEvents()

    expect(registry.restoreFloor(checkpoint)).toBe(SessionLogOffset(cutEvents.length - 1))
    const restored = registry.restore(checkpoint, full, SessionLogOffset(0), session.header, SessionLogOffset(0))
    expect(restored.checkpoint['toolResultSurface']!.val).toEqual(fromZero(registry, full, session.header))
    // The restored row also exposes the tail node's digest.
    const state = restored.checkpoint['toolResultSurface']!.val as ToolResultSurfaceState
    expect(state.nodes.map(node => node.callId)).toEqual(['c1', 'c2'])
    expect(state.nodes[1]!.textHash).toBe(digestToolResultText([{ type: 'text', text: 'b'.repeat(400) }]).textHash)
  })

  it('rejects a malformed ver=3 row instead of serving partial nodes, then refolds clean', () => {
    const { registry } = harness()
    const session = Session.create(SessionId('malformed-v3'))
    appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'x'.repeat(400) }])
    const events = session.snapshotEvents()
    const zero = fromZero(registry, events, session.header)
    const { messageId: _messageId, ...withoutId } = zero.nodes[0]!
    const malformed: ProjectionCheckpoint = {
      toolResultSurface: {
        ver: 3,
        seq: events.at(-1)!.seq,
        val: { ...zero, nodes: [withoutId] },
      },
    }
    // The schema rejects the row; the cache layer retries from the exact log
    // (session-projection-cache owns that fallback), so no partial node escapes.
    expect(() => registry.restore(malformed, events, SessionLogOffset(0), session.header, SessionLogOffset(0)))
      .toThrow()
    expect(registry.restore({}, events, SessionLogOffset(0), session.header, SessionLogOffset(0))
      .checkpoint['toolResultSurface']!.val).toEqual(zero)
  })

  it('hydrates a prepared Session and keeps folding appended events', () => {
    const { registry } = harness()
    const source = Session.create(SessionId('hydrate-source'))
    appendToolTurn(source, 1, 'c1', [{ type: 'text', text: 'x'.repeat(400) }])
    const events = source.snapshotEvents()
    const restoredRow = registry.restore({}, events, SessionLogOffset(0), source.header, SessionLogOffset(0))
      .checkpoint['toolResultSurface']!

    const prepared = Session.create(SessionId('hydrate-source'), events, source.header)
    registry.hydrate(prepared, { toolResultSurface: restoredRow }, events, SessionLogOffset(0))
    // A later turn appends to the restored Session, the same-process continue path.
    appendToolTurn(prepared, 2, 'c2', [{ type: 'text', text: 'z'.repeat(400) }])
    const state = registry.stateOf(prepared, 'toolResultSurface') as ToolResultSurfaceState
    expect(state.nodes.map(node => node.callId)).toEqual(['c1', 'c2'])
    expect(state.surface).toEqual([...prepared.surface.nodes])
  })

  it('keeps the visible messages and digests across a fork at a closed-turn boundary', () => {
    const ctx = new Context()
    const registry = new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new SessionStore(ctx)
    void new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 120 })
    const source = ctx.sessions.create(SessionId('fork-source'))
    appendToolTurn(source, 1, 'c1', [{ type: 'text', text: 'first'.repeat(80) }])
    appendToolTurn(source, 2, 'c2', [{ type: 'text', text: 'second'.repeat(80) }])
    const boundary = source.snapshotEvents().at(-1)!.seq
    const child = ctx.sessions.fork(source, boundary, SessionId('fork-child'))

    const parentState = registry.stateOf(source, 'toolResultSurface') as ToolResultSurfaceState
    const childState = registry.stateOf(child, 'toolResultSurface') as ToolResultSurfaceState
    expect(childState.nodes.map(node => node.messageId)).toEqual(parentState.nodes.map(node => node.messageId))
    expect(childState.nodes.map(node => node.textHash)).toEqual(parentState.nodes.map(node => node.textHash))
    expect(childState.nodes.every(node => node.seq <= boundary)).toBe(true)
    // The child message text is the full logged text, not a summary.
    const derived = new Map(child.deriveMessages().map(message => [message.id, message]))
    const first = derived.get(childState.nodes[0]!.messageId)!
    const text = first.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toBe('first'.repeat(80))
  })

  it('reopens a disposed Session from its log with the same surface', () => {
    const { registry } = harness()
    const session = Session.create(SessionId('disposed'))
    appendToolTurn(session, 1, 'c1', [{ type: 'text', text: 'r'.repeat(400) }])
    const events = session.snapshotEvents()
    const before = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
    // A disposed Session is gone; reopening replays the durable log from zero.
    const reopened = Session.create(SessionId('disposed'), events, session.header)
    const after = registry.stateOf(reopened, 'toolResultSurface') as ToolResultSurfaceState
    expect(after).toEqual(before)
  })
})
