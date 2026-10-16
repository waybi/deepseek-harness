/** Typed PTY backend failures. */

/**
 * Backend-reported failure to clean partial resources after unpublished setup failed.
 * @param spawnError - original setup or cancellation failure.
 * @param cleanupError - failure that may leave backend-owned resources alive.
 */
export class TerminalBackendCleanupError extends AggregateError {
  constructor(
    readonly spawnError: unknown,
    readonly cleanupError: unknown,
  ) {
    super([spawnError, cleanupError], 'PTY backend startup and cleanup both failed')
    this.name = 'TerminalBackendCleanupError'
  }
}
