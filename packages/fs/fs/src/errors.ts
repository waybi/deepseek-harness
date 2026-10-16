/** Typed filesystem error raised by backends and the policy layer. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { FsErrorCode } from './types.ts'

/**
 * Typed filesystem error. Extends {@link HarnessError} so it carries a stable
 * {@link FsErrorCode} and chains `cause`. `dsh-fs` owns this vocabulary so
 * backends and the policy layer raise the same codes instead of each inventing
 * message strings.
 */
export class FsError extends HarnessError {
  override readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
