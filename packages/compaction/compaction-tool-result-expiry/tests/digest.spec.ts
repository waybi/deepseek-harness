import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  digestToolResultText,
  SUMMARY_CODE_POINTS,
  toolResultSurfaceProjection,
} from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { appendToolTurn, scenarioHost } from './support/baseline-scenario.ts'

/**
 * Independent answer for a text digest: concatenate every top-level text
 * block, take the leading code points, and hash the JSON array of block
 * texts. Nothing here calls the implementation under test.
 * @param texts - top-level text-block strings in content order.
 */
function independentDigest(texts: readonly string[]): {
  summary: string
  textChars: number
  textHash: string
} {
  const joined = texts.join('')
  const points = [...joined]
  return {
    summary: points.slice(0, SUMMARY_CODE_POINTS).join(''),
    textChars: points.length,
    textHash: createHash('sha256').update(JSON.stringify(texts), 'utf8').digest('hex').slice(0, 16),
  }
}

const IMAGE: ContentBlock = {
  type: 'image',
  attachment: {
    attachmentId: `sha256:${'b'.repeat(64)}` as never,
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  },
}

/** Content blocks that carry text, in the order the digest sees them. */
function textsOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
}

describe('tool-result text digest', () => {
  it('has a deterministic answer for empty and zero-text content', () => {
    const empty = independentDigest([])
    expect(digestToolResultText([])).toEqual(empty)
    expect(empty).toEqual({ summary: '', textChars: 0, textHash: independentDigest([]).textHash })
    expect(digestToolResultText([IMAGE])).toEqual(empty)
  })

  it('ignores non-text and unknown nested blocks but keeps top-level text in order', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'head' },
      { type: 'reasoning', text: 'not result text' },
      IMAGE,
      { type: 'text', text: 'tail' },
      // Merge-extensible map: an unknown block is not text for expiry.
      { type: 'custom/text-holder', text: 'nested' } as unknown as ContentBlock,
    ]
    expect(digestToolResultText(blocks)).toEqual(independentDigest(['head', 'tail']))
  })

  it('counts code points, not UTF-16 units, across blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '中文😀' },
      { type: 'text', text: 'e\u0301' },
    ]
    const expected = independentDigest(['中文😀', 'e\u0301'])
    expect(expected.textChars).toBe(5)
    expect(digestToolResultText(blocks)).toEqual(expected)
  })

  it('keeps exactly N code points at the N-1, N, and N+1 boundaries', () => {
    for (const size of [SUMMARY_CODE_POINTS - 1, SUMMARY_CODE_POINTS, SUMMARY_CODE_POINTS + 1]) {
      // Emoji are two UTF-16 units each, so this also proves code-point slicing.
      const text = '😀'.repeat(size)
      const digest = digestToolResultText([{ type: 'text', text }])
      expect(digest.textChars).toBe(size)
      expect([...digest.summary]).toHaveLength(Math.min(size, SUMMARY_CODE_POINTS))
      expect(digest).toEqual(independentDigest([text]))
    }
  })

  it('distinguishes block splits that concatenate to the same characters', () => {
    const split = digestToolResultText([{ type: 'text', text: 'ab' }, { type: 'text', text: 'c' }])
    const joined = digestToolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'bc' }])
    expect(split.summary).toBe(joined.summary)
    expect(split.textChars).toBe(joined.textChars)
    expect(split.textHash).not.toBe(joined.textHash)
  })
})

describe('tool-result surface node size and schema', () => {
  const host = scenarioHost('digest-size')
  const big = `${'a'.repeat(100_000)}MIDDLE-MARKER-${'z'.repeat(100_000)}`
  appendToolTurn(host.session, 1, 'big', [{ type: 'text', text: big }])
  const state = host.registry.stateOf(host.session, 'toolResultSurface') as ToolResultSurfaceState
  const node = state.nodes[0]!

  it('keeps a 200KB result out of the node and under the node budget', () => {
    const serialized = JSON.stringify(node)
    expect(serialized.length).toBeLessThan(SUMMARY_CODE_POINTS + 1024)
    expect(serialized).not.toContain('MIDDLE-MARKER')
    expect(node.messageId).toBeDefined()
    expect(node.summary).toBe(big.slice(0, SUMMARY_CODE_POINTS))
    expect(node.textChars).toBe(big.length)
    expect(node.textHash).toBe(independentDigest([big]).textHash)
    expect(node).not.toHaveProperty('data')
    expect(node.fields).toEqual({ turn: 1, step: 1 })
  })

  it('accepts the folded state and rejects a row with the removed data field', () => {
    const schema = toolResultSurfaceProjection.stateSchema
    expect(schema.safeParse(state).success).toBe(true)

    const { summary: _summary, ...withoutSummary } = node
    expect(schema.safeParse({ ...state, nodes: [withoutSummary] }).success).toBe(false)

    const legacy = { ...node, data: { turn: 1, step: 1, message: {} } }
    expect(schema.safeParse({ ...state, nodes: [legacy] }).success).toBe(false)

    const badHash = { ...node, textHash: 'not-a-hash' }
    expect(schema.safeParse({ ...state, nodes: [badHash] }).success).toBe(false)
  })
})

describe('random text-tree cross-check', () => {
  /** Deterministic PRNG so a failure names a replayable seed. */
  function rng(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
  }

  const ALPHABET = ['a', 'Z', ' ', '\n', '中', '文', '😀', '🎉', 'e\u0301', '\u{1F1E8}']

  /** Build one random content tree. */
  function randomBlocks(seed: number): ContentBlock[] {
    const next = rng(seed)
    const count = Math.floor(next() * 6)
    const blocks: ContentBlock[] = []
    for (let index = 0; index < count; index += 1) {
      const kind = next()
      if (kind < 0.7) {
        const length = Math.floor(next() * 400)
        let text = ''
        for (let char = 0; char < length; char += 1) {
          text += ALPHABET[Math.floor(next() * ALPHABET.length)]!
        }
        blocks.push({ type: 'text', text })
      } else if (kind < 0.8) {
        blocks.push({ type: 'reasoning', text: 'reasoning' })
      } else if (kind < 0.9) {
        blocks.push(IMAGE)
      } else {
        blocks.push({ type: 'custom/unknown', text: 'ignored' } as unknown as ContentBlock)
      }
    }
    return blocks
  }

  /**
   * Check one case and return the mismatch, or `undefined` when it matches.
   * @param seed - case seed.
   * @param driftChars - non-zero to deliberately corrupt the expected count.
   */
  function check(seed: number, driftChars = 0): string | undefined {
    const blocks = randomBlocks(seed)
    const expected = independentDigest(textsOf(blocks))
    expected.textChars += driftChars
    const actual = digestToolResultText(blocks)
    return JSON.stringify(actual) === JSON.stringify(expected)
      ? undefined
      : `seed ${seed}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`
  }

  it('matches an independent answer for 10000 seeded trees', () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 10_000; seed += 1) {
      const failure = check(seed)
      if (failure !== undefined) {
        failures.push(failure)
        if (failures.length === 3) break
      }
    }
    expect(failures).toEqual([])
  })

  it('catches one deliberately drifted expectation and names its seed', () => {
    const seed = 4_242
    const failure = check(seed, 1)
    expect(failure).toContain(`seed ${seed}`)
    // The clean run for the same seed passes again.
    expect(check(seed)).toBeUndefined()
  })
})
