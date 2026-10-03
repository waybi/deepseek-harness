import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { compileDeferredPatterns, defineTool, searchDeferredTools, TOOL_SEARCH_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const testToolSignal = new AbortController().signal

/** Agent-like scope key carrying a live session, as the agent loop's Agent does. */
type SessionAgent = Agent & { session: Session }

async function mount(deferred: string[] = [], projections = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  if (projections) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime, { deferred })
  return ctx
}

async function mintAgent(
  ctx: Context,
  name: string,
  session = Session.create(SessionId(name)),
): Promise<{ scope: Scope; key: SessionAgent }> {
  const key = { id: name as SessionId, session } as SessionAgent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function tool(name: string, description = `tool ${name}`, exposure?: 'direct' | 'deferred'): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    ...exposure === undefined ? {} : { exposure },
    execute: () => Promise.resolve(`ran:${name}`),
  })
}

async function run(ctx: Context, name: string, agent: Agent | undefined, args: unknown = {}): Promise<string> {
  const result = await ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`c-${name}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function names(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

describe('deferred patterns and search ranking', () => {
  it('matches exact names and trailing-star prefixes only', () => {
    const matches = compileDeferredPatterns(['de_*', 'workflow', 'mcp__*'])
    expect(matches('de_broadcast')).toBe(true)
    expect(matches('workflow')).toBe(true)
    expect(matches('workflows')).toBe(false)
    expect(matches('mcp__lark__doc')).toBe(true)
    expect(matches('read')).toBe(false)
  })

  it('ranks exact name, then substring, then term overlap, capped at five', () => {
    const pool = [
      tool('de_broadcast', 'Broadcast a message to other sessions'),
      tool('de_session', 'Spawn or wake a session'),
      tool('workflow', 'Run a multi-agent workflow script'),
      tool('mcp__lark__doc', 'Read a Feishu document'),
      tool('a1', 'message one'), tool('a2', 'message two'), tool('a3', 'message three'), tool('a4', 'message four'),
    ]
    expect(searchDeferredTools('workflow', pool).map(t => t.name)).toEqual(['workflow'])
    expect(searchDeferredTools('broadcast message', pool)[0]?.name).toBe('de_broadcast')
    expect(searchDeferredTools('feishu', pool).map(t => t.name)).toEqual(['mcp__lark__doc'])
    expect(searchDeferredTools('message', pool)).toHaveLength(5)
    expect(searchDeferredTools('   ', pool)).toEqual([])
    expect(searchDeferredTools('nothing-here', pool)).toEqual([])
  })
})

describe('deferred exposure through the registry', () => {
  it('declares nothing special when no tool is deferred', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('read'))
    const { key } = await mintAgent(ctx, 'plain')
    expect(names(ctx, key)).toEqual(['read'])
    expect(await run(ctx, TOOL_SEARCH_NAME, key, { query: 'read' })).toBe(`Error: unknown tool "${TOOL_SEARCH_NAME}"`)
    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembly.sections.find(section => section.name === 'tools:search')?.text).toBe('')
  })

  it('hides deferred tools behind tool_search, whose description catalogs them', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('de_broadcast', 'Broadcast a message to other sessions. Long tail of detail follows.'))
    ctx.tools.register(tool('de_session', 'Spawn or wake a session.'))
    const { key } = await mintAgent(ctx, 'hidden')

    const schemas = ctx.tools.schemas(key)
    expect(schemas.map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
    const search = schemas.find(schema => schema.name === TOOL_SEARCH_NAME)!
    expect(search.description).toContain('- de_broadcast: Broadcast a message to other sessions.')
    expect(search.description).toContain('- de_session: Spawn or wake a session.')
    expect(search.description).not.toContain('Long tail')

    // Hidden tools are not callable before a reveal; the prompt and executor agree.
    expect(await run(ctx, 'de_broadcast', key)).toBe('Error: unknown tool "de_broadcast"')
    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
    expect(assembly.sections.find(section => section.name === 'tools:search')?.text).toContain(TOOL_SEARCH_NAME)
  })

  it('reveals searched tools durably and appends their schemas after the existing ones', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('de_broadcast', 'Broadcast a message to other sessions.'))
    ctx.tools.register(tool('de_session', 'Spawn or wake a session.'))
    const { key } = await mintAgent(ctx, 'reveal')

    const text = await run(ctx, TOOL_SEARCH_NAME, key, { query: 'broadcast' })
    expect(text).toContain('Revealed 1 tool(s): de_broadcast')
    expect(text).toContain('## de_broadcast')
    expect(key.session.snapshotEvents().filter(event => event.type === 'tools/reveal').map(event => event.data))
      .toEqual([{ names: ['de_broadcast'] }])

    // The revealed schema lands after the still-declared ones; de_session stays hidden.
    expect(names(ctx, key)).toEqual(['read', 'de_broadcast', TOOL_SEARCH_NAME])
    expect(await run(ctx, 'de_broadcast', key)).toBe('ran:de_broadcast')
    expect(await run(ctx, 'de_session', key)).toBe('Error: unknown tool "de_session"')
    const search = ctx.tools.schemas(key).find(schema => schema.name === TOOL_SEARCH_NAME)!
    expect(search.description).not.toContain('de_broadcast')
    expect(search.description).toContain('de_session')

    // A revealed tool has left the catalog, so searching it again neither matches nor re-logs.
    expect(await run(ctx, TOOL_SEARCH_NAME, key, { query: 'de_broadcast' })).toContain('No deferred tool matches')
    expect(key.session.snapshotEvents().filter(event => event.type === 'tools/reveal')).toHaveLength(1)

    // Once every deferred tool is revealed, tool_search disappears.
    await run(ctx, TOOL_SEARCH_NAME, key, { query: 'session' })
    expect(names(ctx, key)).toEqual(['read', 'de_broadcast', 'de_session'])
    expect(await run(ctx, TOOL_SEARCH_NAME, key, { query: 'x' })).toBe(`Error: unknown tool "${TOOL_SEARCH_NAME}"`)
  })

  it('restores reveals from the session log in a fresh process and keeps them across compaction-style rewrites', async () => {
    const first = await mount(['de_*'])
    first.tools.register(tool('de_broadcast'))
    const session = Session.create(SessionId('persist'))
    const a = await mintAgent(first, 'persist', session)
    await run(first, TOOL_SEARCH_NAME, a.key, { query: 'de_broadcast' })

    // A new registry over a session reconstructed from the same events.
    const replay = Session.create(SessionId('persist'), session.snapshotEvents())
    const second = await mount(['de_*'])
    second.tools.register(tool('de_broadcast'))
    const b = await mintAgent(second, 'persist-2', replay)
    expect(names(second, b.key)).toEqual(['de_broadcast'])
    expect(await run(second, 'de_broadcast', b.key)).toBe('ran:de_broadcast')
  })

  it('remembers reveals per process when no projection registry is mounted', async () => {
    const ctx = await mount(['de_*'], false)
    ctx.tools.register(tool('de_broadcast'))
    const { key } = await mintAgent(ctx, 'no-projections')
    await run(ctx, TOOL_SEARCH_NAME, key, { query: 'de_broadcast' })
    expect(names(ctx, key)).toEqual(['de_broadcast'])
    expect(key.session.snapshotEvents().filter(event => event.type === 'tools/reveal')).toHaveLength(1)
  })

  it('reveals nothing for a scope without a session and leaves the global view undeclared', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('de_broadcast'))
    expect(names(ctx)).toEqual([TOOL_SEARCH_NAME])
    const text = await run(ctx, TOOL_SEARCH_NAME, undefined, { query: 'broadcast' })
    expect(text).toContain('already revealed')
    expect(names(ctx)).toEqual([TOOL_SEARCH_NAME])
  })

  it('lets a definition override the configured pattern in both directions', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('de_direct', 'always declared', 'direct'))
    ctx.tools.register(tool('lazy', 'opts in', 'deferred'))
    const { key } = await mintAgent(ctx, 'override')
    expect(names(ctx, key)).toEqual(['de_direct', TOOL_SEARCH_NAME])
    const search = ctx.tools.schemas(key).find(schema => schema.name === TOOL_SEARCH_NAME)!
    expect(search.description).toContain('- lazy: opts in')
  })

  it('keeps restricted deferred tools out of the catalog, the search, and execution', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('de_broadcast', 'Broadcast a message.'))
    ctx.tools.register(tool('de_session', 'Spawn a session.'))
    const { scope, key } = await mintAgent(ctx, 'restricted')
    scope.ctx.tools.restrict({ deny: ['de_session'] })

    const search = ctx.tools.schemas(key).find(schema => schema.name === TOOL_SEARCH_NAME)!
    expect(search.description).toContain('de_broadcast')
    expect(search.description).not.toContain('de_session')
    expect(await run(ctx, TOOL_SEARCH_NAME, key, { query: 'session' })).toContain('No deferred tool matches')
    expect(await run(ctx, 'de_session', key)).toBe('Error: unknown tool "de_session"')
    expect(key.session.snapshotEvents().some(event => event.type === 'tools/reveal')).toBe(false)

    // An allow-list that keeps only direct tools leaves nothing to search: tool_search is gone too.
    const other = await mintAgent(ctx, 'allow-only')
    other.scope.ctx.tools.restrict({ allow: ['read'] })
    expect(names(ctx, other.key)).toEqual(['read'])
  })

  it('reserves the tool_search name against registration and restriction', async () => {
    const ctx = await mount(['de_*'])
    expect(() => ctx.tools.register(tool(TOOL_SEARCH_NAME))).toThrow(/reserved for the deferred-tool discovery transport/)
    const { scope } = await mintAgent(ctx, 'reserve')
    expect(() => scope.ctx.tools.restrict({ deny: [TOOL_SEARCH_NAME] })).toThrow(/cannot name reserved discovery transport/)
  })
})
