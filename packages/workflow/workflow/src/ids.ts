/** Branded workflow run identity and its constructor. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one workflow run. */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/**
 * Brand a string as a {@link WorkflowRunId}.
 * @param id - the raw id string (the engine mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}
