// CJK density: the shared estimator prices Han, Kana, and Hangul at 1.8
// characters per token while Latin text keeps 4.

import { describe, expect, it } from 'vitest'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { estimateSystemMessage, estimateTextTokens, estimateToolsTokens } from '../src/estimate.ts'

const CONFIG = { provider: 'test', model: 'test-model' }

function tools(description: string): ToolSchema[] {
  return [{ name: 'bash', description, parameters: { type: 'object', properties: {} } }]
}

describe('estimateTextTokens', () => {
  it('prices pure ASCII at the Latin density', () => {
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcd')).toBe(Math.ceil('abcd'.length / 4))
    expect(estimateTextTokens('abcdefghij')).toBe(3)
  })

  it('prices pure Chinese at 1.8 characters per token', () => {
    expect(estimateTextTokens('中文测试')).toBe(Math.ceil(4 / 1.8))
    expect(estimateTextTokens('中文测试')).toBe(3)
  })

  it('prices Han, Hiragana, Katakana, and Hangul by the same CJK density', () => {
    expect(estimateTextTokens('漢')).toBe(1)
    expect(estimateTextTokens('あ')).toBe(1)
    expect(estimateTextTokens('한')).toBe(1)
    // Three CJK characters round up from 1.67 to 2 tokens.
    expect(estimateTextTokens('漢あ한')).toBe(Math.ceil(3 / 1.8))
    expect(estimateTextTokens('漢あ한')).toBe(2)
  })

  it('rounds the CJK part and the rest separately in mixed text', () => {
    // cjk = 2, rest = 2: ceil(2 / 1.8) + ceil(2 / 4) = 2 + 1.
    expect(estimateTextTokens('ab中文')).toBe(3)
    expect(estimateTextTokens('中文ab')).toBe(3)
  })

  it('prices the empty string to zero', () => {
    expect(estimateTextTokens('')).toBe(0)
  })
})

describe('CJK density in the composite estimators', () => {
  it('prices a Chinese system prompt above an ASCII prompt of equal length', () => {
    const chinese = estimateSystemMessage(createSystemMessage('中文测试'))
    const ascii = estimateSystemMessage(createSystemMessage('abcd'))
    expect(ascii).toBe(1 + 4)
    expect(chinese).toBe(3 + 4)
    expect(chinese).toBeGreaterThan(ascii)
  })

  it('prices Chinese tool schemas above ASCII schemas of equal length', () => {
    const chinese = estimateToolsTokens({ config: CONFIG, tools: tools('中文测试') })
    const ascii = estimateToolsTokens({ config: CONFIG, tools: tools('abcd') })
    expect(chinese).toBeGreaterThan(ascii)
  })
})
