/** Configuration resolution for cold tool-result expiry. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig, ToolResultExpiryConfig } from './types.ts'

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  coldTurns: 3,
  thresholdChars: 2048,
  sweepEvery: 30,
  idleSweepMs: 3_600_000,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'coldTurns',
  'thresholdChars',
  'sweepEvery',
  'idleSweepMs',
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
 * Stub for an expired result whose spill-policy notice is retained after it:
 * the complete output is still on disk, so the model should read the stored
 * file instead of rerunning a possibly side-effecting tool.
 * @param toolName - tool that produced the original result.
 * @param chars - removed preview size in Unicode code points.
 * @returns the complete stub text, without the retained notice.
 */
export function expiredStubWithSpill(toolName: string, chars: number): string {
  return `[${toolName} output from an earlier turn expired: ${chars} characters removed; the complete result is still stored at the path below, read that file instead of rerunning the tool]`
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
        `ToolResultExpiryConfig: unknown key "${key}" (allowed: coldTurns, thresholdChars, sweepEvery, idleSweepMs)`,
      )
    }
  }
  const resolved: ResolvedConfig = {
    coldTurns: config.coldTurns ?? DEFAULTS.coldTurns,
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    sweepEvery: config.sweepEvery ?? DEFAULTS.sweepEvery,
    idleSweepMs: config.idleSweepMs ?? DEFAULTS.idleSweepMs,
  }
  assertPositiveInteger('coldTurns', resolved.coldTurns)
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertPositiveInteger('sweepEvery', resolved.sweepEvery)
  assertPositiveInteger('idleSweepMs', resolved.idleSweepMs)
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultExpiryConfig: ${name} (${value}) must be a positive integer`)
  }
}
