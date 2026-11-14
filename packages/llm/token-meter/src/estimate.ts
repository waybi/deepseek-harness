/**
 * Script-aware heuristic token pricing shared by the meter service and the pure
 * context-breakdown projection, so both surfaces price identical content to
 * identical numbers.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/** Latin text density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/**
 * CJK text density in characters per token. Chinese, Japanese, and Korean
 * tokenizers split text far more finely than Latin prose: one token covers
 * about 1.8 characters instead of 4, so pricing CJK at the Latin density
 * undercounts a CJK conversation's context occupancy by more than half. The
 * figure follows WorkBuddy 5.9.4, which prices Han, Kana, and Hangul this way.
 */
const CJK_CHARS_PER_TOKEN = 1.8

/** Han, Hiragana, Katakana, and Hangul code points, which price at the CJK density. */
const CJK_CHARACTERS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Pure-ASCII fast path: such text holds no CJK character, so one density applies. */
const ASCII_ONLY = /^[\u0000-\u007f]*$/

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Estimate tokens for one string under separate Latin and CJK densities.
 *
 * The CJK part and the remaining characters round up independently, so neither
 * density borrows a fractional token from the other.
 * @param text - text to price.
 * @returns estimated tokens; 0 for the empty string.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0
  if (ASCII_ONLY.test(text)) return Math.ceil(text.length / CHARS_PER_TOKEN)
  const cjk = text.match(CJK_CHARACTERS)?.length ?? 0
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN) + Math.ceil((text.length - cjk) / CHARS_PER_TOKEN)
}

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * structural heuristic for merge-extended blocks and for image references,
 * whose request price is route-owned rather than fixed. Image offload marks do
 * not change this reference-only heuristic; route pricing owns their
 * placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(reference))
  }
  return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the script-aware density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateTextTokens(block.name)
          + estimateTextTokens(block.arguments)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the structural heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let tokens = 0
  for (const block of message.content) {
    tokens += estimateTextTokens(block.type === 'text' ? block.text : JSON.stringify(block))
  }
  return tokens + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the script-aware heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateTextTokens(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}
