import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultExpiry from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { appendToolTurn } from './support/baseline-scenario.ts'

/** Measured share of `toolResultSurface` in the 1.71GB projection cache (2026-11-10 diagnosis). */
const MEASURED_PROJECTION_SHARE = 0.576
const SESSIONS = 100

interface Volume {
  before: number
  after: number
  results: number
}

/**
 * Bytes the version-2 row would have needed for the same log: every node
 * carried the complete `tool/result` `data`, including the message content.
 */
function legacyStateBytes(state: ToolResultSurfaceState, events: ReturnType<Session['snapshotEvents']>): number {
  const nodes = state.nodes.map((node) => {
    const source = events[node.seq]!
    if (source.type !== 'tool/result') throw new Error(`seq ${node.seq} is not a tool/result`)
    return { seq: node.seq, turn: node.turn, callId: node.callId, toolName: node.toolName, data: source.data }
  })
  return Buffer.byteLength(JSON.stringify({ surface: state.surface, nodes, toolNames: state.toolNames }), 'utf8')
}

describe('projection cache volume on synthetic large results', () => {
  it('shrinks the toolResultSurface row by at least 45% and reports the cache-wide formula', () => {
    const ctx = new Context()
    const registry = new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 2048 })
    let volume: Volume = { before: 0, after: 0, results: 0 }

    for (let index = 0; index < SESSIONS; index += 1) {
      const session = Session.create(SessionId(`volume-${index}`))
      // One result well above 100KB plus two ordinary ones.
      const big = `result-${index}-`.repeat(10_000)
      appendToolTurn(session, 1, 'c1', [{ type: 'text', text: big }], { toolName: 'read_file' })
      appendToolTurn(session, 2, 'c2', [{ type: 'text', text: `small-${index}`.repeat(40) }])
      appendToolTurn(session, 3, 'c3', [{ type: 'text', text: `medium-${index}`.repeat(400) }])
      const events = session.snapshotEvents()
      const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
      volume = {
        before: volume.before + legacyStateBytes(state, events),
        after: volume.after + Buffer.byteLength(JSON.stringify(state), 'utf8'),
        results: volume.results + state.nodes.length,
      }
    }

    const reduction = (volume.before - volume.after) / volume.before
    const estimatedTotal = reduction * MEASURED_PROJECTION_SHARE
    const report = {
      sessions: SESSIONS,
      results: volume.results,
      projectionBeforeBytes: volume.before,
      projectionAfterBytes: volume.after,
      reduction: Number(reduction.toFixed(4)),
      measuredProjectionShare: MEASURED_PROJECTION_SHARE,
      estimatedTotalCacheReduction: Number(estimatedTotal.toFixed(4)),
      formula: '(projectionBefore - projectionAfter) / projectionBefore, then x 0.576 measured share for the whole cache',
      note: '存量 ver=2 旧行不会自动变小，只统计新生成的投影行',
    }
    console.log(`VOLUME_REPORT ${JSON.stringify(report)}`)

    expect(volume.before).toBeGreaterThan(volume.after * 10)
    expect(reduction).toBeGreaterThanOrEqual(0.45)
    expect(estimatedTotal).toBeGreaterThanOrEqual(0.45)
  }, 120_000)
})
