/** Configuration resolution for cold tool-result expiry. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig, ToolResultExpiryConfig } from './types.ts'

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  coldTurns: 3,
  thresholdChars: 2048,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'coldTurns',
  'thresholdChars',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Model-visible stub that replaces an expired tool result. Names the tool and
 * the removed size so the model can decide whether to run the call again.
 * @param toolName - tool that produced the original result.
 * @param chars - original text size in Unicode code points.
 * @returns the complete stub text.
 */
export function expiredStub(toolName: string, chars: number): string {
  return `[${toolName} output from an earlier turn expired: ${chars} characters removed; rerun the tool to see it again]`
}

/**
 * Resolve and validate expiry policy.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultExpiryConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultExpiryConfig: unknown key "${key}" (allowed: coldTurns, thresholdChars)`,
      )
    }
  }
  const resolved: ResolvedConfig = {
    coldTurns: config.coldTurns ?? DEFAULTS.coldTurns,
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
  }
  assertPositiveInteger('coldTurns', resolved.coldTurns)
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultExpiryConfig: ${name} (${value}) must be a positive integer`)
  }
}
