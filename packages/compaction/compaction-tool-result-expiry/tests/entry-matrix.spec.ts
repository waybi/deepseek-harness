import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { Context } from '@deepseek-ai/cordis'
import ToolResultExpiry, { expiredStub, SUMMARY_CODE_POINTS } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { appendToolTurn } from './support/baseline-scenario.ts'

const BIG = 120_000

/** Host entry points that write a tool result into one Session. */
const ENTRIES = ['web-ui', 'cli', 'remote-api', 'ai-tool-call', 'scheduler', 'script'] as const
/** Shipped profiles; all compose the same expiry service and Session contract. */
const PROFILES = ['desktop', 'web-app', 'headless', 'acp', 'bot'] as const

interface Host {
  ctx: Context
  registry: SessionProjectionRegistry
  expiry: ToolResultExpiry
}

function host(): Host {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const expiry = new ToolResultExpiry(ctx, { coldTurns: 2, thresholdChars: 2048 })
  return { ctx, registry, expiry }
}

/** Independent digest, never calling the product helper. */
function independentDigest(text: string): string {
  return createHash('sha256').update(JSON.stringify([text]), 'utf8').digest('hex').slice(0, 16)
}

describe('every entry and profile lands the same projection and expiry result', () => {
  for (const entry of ENTRIES) {
    for (const profile of PROFILES) {
      it(`${entry} on ${profile} stores a bounded node and expires from derived text`, () => {
        const { registry, expiry } = host()
        const session = Session.create(SessionId(`${entry}-${profile}`))
        const text = `${profile} from ${entry} `.repeat(Math.ceil(BIG / 16)).slice(0, BIG)
        const seq = appendToolTurn(session, 1, 'call', [{ type: 'text', text }], { toolName: 'read_file' })
        session.append('turn/start', { turn: 3 })

        const state = registry.stateOf(session, 'toolResultSurface') as ToolResultSurfaceState
        const node = state.nodes[0]!
        expect(JSON.stringify(node).length).toBeLessThan(SUMMARY_CODE_POINTS + 1024)
        expect(node.textChars).toBe([...text].length)
        expect(node.textHash).toBe(independentDigest(text))

        const result = expiry.expireSession(session, 3)
        expect(result.expired.map(item => item.originalSeq)).toEqual([seq])
        expect(result.expired[0]!.charsBefore).toBe([...text].length)
        // The replacement text is the stub, while the original event keeps the full text.
        const replacement = session.snapshotEvents().at(-1)!
        expect(replacement.type).toBe('tool/result')
        const stub = (replacement as Extract<typeof replacement, { type: 'tool/result' }>).data.message.content[0]
        expect(stub).toEqual({ type: 'text', text: expiredStub('read_file', result.expired[0]!.charsBefore) })
      })
    }
  }
})
