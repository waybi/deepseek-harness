/**
 * Declared tool schemas are ordered by name, not by registration order, so the
 * same tool set is byte-identical in every request: the declarations sit at the
 * head of the request and the provider's KV cache matches a prefix byte for byte.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { compareToolNames, defineTool, TOOL_SEARCH_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

/** Agent-like scope key carrying a live session, as the agent loop's Agent does. */
type SessionAgent = Agent & { session: Session }

const contexts: Context[] = []

async function mount(deferred: string[] = []): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime, { deferred })
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

async function mintAgent(ctx: Context, name: string): Promise<SessionAgent> {
  const key = { id: name as SessionId, session: Session.create(SessionId(name)) } as SessionAgent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return key
}

function tool(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `tool ${name}`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  })
}

/** Declarations of one assembled request, typed for name-order assertions. */
interface Declaration {
  readonly name: string
  readonly description?: string
}

/** Read the tool declarations out of one assembled request's JSON. */
function declarationsOf(assembly: string): Declaration[] {
  const parsed = JSON.parse(assembly) as { tools: Declaration[] }
  return parsed.tools
}

/** Register one tool set in the given order and return its model-visible declarations. */
async function declarations(names: readonly string[], deferred: string[] = []): Promise<string> {
  const ctx = await mount(deferred)
  for (const name of names) ctx.tools.register(tool(name))
  const key = await mintAgent(ctx, 'order')
  return JSON.stringify(await ctx.systemPrompt.assemble({ scope: key }))
}

const NAMES = ['read', 'write', 'bash', 'grep', 'todo_write']

describe('declared tool order', () => {
  it('orders declarations by name whatever order the plugins register in', async () => {
    const forward = await declarations(NAMES)
    const reverse = await declarations([...NAMES].reverse())
    const shuffled = await declarations(['grep', 'todo_write', 'read', 'bash', 'write'])

    expect(forward).toBe(reverse)
    expect(forward).toBe(shuffled)
    expect(declarationsOf(forward).map(schema => schema.name))
      .toEqual(['bash', 'grep', 'read', 'todo_write', 'write'])
  })

  it('keeps the reserved tool_search declaration in name position with a stable catalog', async () => {
    const deferred = ['grep', 'todo_write']
    const forward = await declarations(NAMES, deferred)
    const reverse = await declarations([...NAMES].reverse(), deferred)

    expect(forward).toBe(reverse)
    const schemas = declarationsOf(forward)
    expect(schemas.map(schema => schema.name)).toEqual(['bash', 'read', TOOL_SEARCH_NAME, 'write'])
    const catalog = schemas.find(schema => schema.name === TOOL_SEARCH_NAME)!.description!
    expect(catalog.indexOf('- grep')).toBeLessThan(catalog.indexOf('- todo_write'))
  })

  it('orders revealed deferred tools by name instead of appending them', async () => {
    const ctx = await mount(['grep', 'todo_write'])
    for (const name of ['write', 'read', 'bash', 'grep', 'todo_write']) ctx.tools.register(tool(name))
    const key = await mintAgent(ctx, 'order-reveal')
    expect(ctx.tools.schemas(key).map(schema => schema.name))
      .toEqual(['bash', 'read', TOOL_SEARCH_NAME, 'write'])

    // Revealing the alphabetically later hidden tool inserts it before `write`.
    const batch = await ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{
        type: 'tool-call', id: ToolCallId('c-search'), name: TOOL_SEARCH_NAME,
        arguments: JSON.stringify({ query: 'todo_write' }),
      }],
      agent: key,
    })
    expect(batch.results[0]!.result.content[0]).toMatchObject({ type: 'text' })
    expect(ctx.tools.schemas(key).map(schema => schema.name))
      .toEqual(['bash', 'read', 'todo_write', TOOL_SEARCH_NAME, 'write'])
  })

  it('compares names by the shared collation rule', () => {
    expect(compareToolNames({ name: 'read' }, { name: 'write' })).toBeLessThan(0)
    expect(compareToolNames({ name: 'write' }, { name: 'read' })).toBeGreaterThan(0)
    expect(compareToolNames({ name: 'read' }, { name: 'read' })).toBe(0)
    // The rule is explicit `en` collation, not the host locale.
    expect([...NAMES].sort((a, b) => compareToolNames({ name: a }, { name: b })))
      .toEqual(['bash', 'grep', 'read', 'todo_write', 'write'])
  })
})
