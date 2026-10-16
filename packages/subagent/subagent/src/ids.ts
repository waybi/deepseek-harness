/** Branded subagent run identity and its constructor. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one accepted subagent run across its lifecycle event pair. */
export type SubagentRunId = Branded<'SubagentRunId'>

/**
 * Brand a string as a {@link SubagentRunId}.
 * @param id - the raw run id.
 * @returns the same string, branded.
 */
export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}
