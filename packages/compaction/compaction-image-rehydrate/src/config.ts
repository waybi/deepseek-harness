/** Policy resolution and the model-visible placeholder for round-age image hydration. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ImageRehydrateConfig, ResolvedConfig } from './types.ts'

/** Low-friction defaults: keep the current round and the one before it, replace the rest. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  retainRounds: 2,
  enabled: true,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set(['retainRounds', 'enabled'])

/**
 * Model-visible placeholder for one replaced image. It names the image, its
 * encoded size, and the read-only stored copy the model may read again with
 * its file tools; nothing else about the image survives on the request face.
 * @param ref - durable normalized attachment the placeholder stands for.
 * @param path - absolute read-only path of the stored copy.
 * @returns the complete placeholder text.
 */
export function imagePlaceholder(ref: ImageAttachmentRef, path: string): string {
  const name = ref.name ?? '(unnamed)'
  return `[Image from ${name} (${ref.mediaType}, ${ref.bytes} bytes) - stored at: ${path}]`
}

/**
 * Resolve and validate the hydration policy.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 * @throws when a key is unknown or a value is outside its accepted range.
 */
export function resolveConfig(config: ImageRehydrateConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ImageRehydrateConfig: unknown key "${key}" (allowed: retainRounds, enabled)`)
    }
  }
  const resolved: ResolvedConfig = {
    retainRounds: config.retainRounds ?? DEFAULTS.retainRounds,
    enabled: config.enabled ?? DEFAULTS.enabled,
  }
  if (!Number.isInteger(resolved.retainRounds) || resolved.retainRounds < 1) {
    throw new Error(
      `ImageRehydrateConfig: retainRounds (${resolved.retainRounds}) must be a positive integer; the current turn never loses its own images`,
    )
  }
  if (typeof resolved.enabled !== 'boolean') {
    throw new Error(`ImageRehydrateConfig: enabled (${String(resolved.enabled)}) must be a boolean`)
  }
  return deepFreeze(structuredClone(resolved))
}
