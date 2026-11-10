import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codePointLength, expiredStub } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { buildScenario, canonicalize, normalizeAppended, scenarioHost } from './support/baseline-scenario.ts'

/**
 * Appended events recorded from the implementation that kept complete
 * `tool/result` data in the projection, before the projection stored only
 * text digests. Message text, metadata, error fields, offloaded images, and
 * the field sets must stay identical apart from `seq`, `time`, and message ids.
 */
const BASELINE = JSON.parse(readFileSync(new URL('./fixtures/expiry-baseline.json', import.meta.url), 'utf8')) as {
  expired: unknown[]
  charsRemoved: number
  appended: unknown[]
}

/**
 * Candidates an expiry pass must rewrite, derived from the scenario by hand:
 * cold large text (c1), text with an offloaded image (c2), error with metadata
 * (c4), and multi-block text plus emoji (c5). `c3` is below the threshold and
 * `c6` is in the current turn, so both keep their text.
 */
const TARGET_CALLS = ['c1', 'c2', 'c4', 'c5']
const KEPT_TEXT: Record<string, string> = {
  c3: 'small',
  c6: 'w'.repeat(400),
}

describe('tool-result expiry output lock', () => {
  it('appends the recorded prune and replacement events for the fixed scenario', () => {
    const { expiry, session } = scenarioHost('baseline')
    buildScenario(session)
    const before = session.snapshotEvents().length
    const result = expiry.expireSession(session, 7)
    const appended = session.snapshotEvents().slice(before)
    expect(result.expired.map(({ replacementSeq: _replacement, ...entry }) => entry)).toEqual(BASELINE.expired)
    expect(result.charsRemoved).toBe(BASELINE.charsRemoved)
    expect(normalizeAppended(appended)).toEqual(canonicalize(BASELINE.appended))
  })

  it('rewrites the independently listed targets and keeps the others verbatim', () => {
    const { expiry, session } = scenarioHost('baseline-targets')
    buildScenario(session)
    const events = session.snapshotEvents()
    const result = expiry.expireSession(session, 7)
    expect(result.expired.map(entry => entry.callId)).toEqual(TARGET_CALLS)
    // The appended replacement carries the stub and every non-message field.
    const appended = session.snapshotEvents().slice(events.length)
    for (let index = 0; index < result.expired.length; index += 1) {
      const entry = result.expired[index]!
      const replacement = appended[index * 2 + 1]!
      expect(replacement.type).toBe('tool/result')
      const data = (replacement as Extract<typeof replacement, { type: 'tool/result' }>).data
      const original = events[entry.originalSeq]!
      expect(original.type).toBe('tool/result')
      const originalData = (original as Extract<typeof original, { type: 'tool/result' }>).data
      const { message: _originalMessage, ...originalFields } = originalData
      const { message, ...fields } = data
      expect(fields).toEqual(originalFields)
      expect(message.content[0]).toEqual({ type: 'text', text: expiredStub(entry.callId === 'c4' ? 'bash' : entry.callId === 'c1' ? 'read_file' : entry.callId === 'c2' ? 'screenshot' : 'bash', entry.charsBefore) })
      expect(entry.charsAfter).toBe(codePointLength(expiredStub(
        entry.callId === 'c1' ? 'read_file' : entry.callId === 'c2' ? 'screenshot' : 'bash',
        entry.charsBefore,
      )))
    }
    // Untouched results keep their complete text on the derived surface.
    const derived = new Map(session.deriveMessages().map(message => [message.id, message]))
    for (const [callId, text] of Object.entries(KEPT_TEXT)) {
      const source = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
      expect(source).toBeDefined()
      const message = derived.get((source as Extract<typeof source, { type: 'tool/result' }>).data.message.id)!
      const blocks = message.content.filter(block => block.type === 'text').map(block => block.text)
      expect(blocks.join('')).toBe(text)
    }
  })
})
