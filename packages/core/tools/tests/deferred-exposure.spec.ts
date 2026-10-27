import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { compileDeferredGroups, compileDeferredPatterns, defineTool, searchDeferredTools, TOOL_SEARCH_NAME } from '@deepseek-ai/dsh-tools'
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

  it('excludes names with a leading bang and groups by the most specific pattern', () => {
    const group = compileDeferredGroups(['de_ws_*', 'de_coi_*', 'de_*', '!de_session', 'mcp__*', 'workflow'])
    expect(group('de_session')).toBeUndefined()
    expect(group('de_ws_status')).toBe('de_ws_*')
    expect(group('de_coi_dispatch')).toBe('de_coi_*')
    expect(group('de_broadcast')).toBe('de_*')
    expect(group('workflow')).toBe('workflow')
    expect(group('mcp__kimi-cu__click')).toBe('mcp__kimi-cu__')
    expect(group('mcp__lark_project__get')).toBe('mcp__lark_project__')
    expect(group('read')).toBeUndefined()
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

  it('matches Chinese query terms as description substrings', () => {
    const pool = [
      tool('de_broadcast', '会话广播：DSH 会话之间传递消息'),
      tool('dtodo', '待办管理（四轨：life 生活 / work 工作）'),
      tool('workflow', 'Run a multi-agent workflow script'),
    ]
    const search = (query: string): string[] => searchDeferredTools(query, pool).map(t => t.name)
    expect(search('广播')).toEqual(['de_broadcast'])
    expect(search('待办')).toEqual(['dtodo'])
    expect(search('发 广播')[0]).toBe('de_broadcast')
    expect(search('不存在的词')).toEqual([])
    expect(search('广播站')).toEqual([])
    const mixed = search('broadcast 广播')
    expect(mixed[0]).toBe('de_broadcast')
    expect(new Set(mixed).size).toBe(mixed.length)
  })

  it('ranks Chinese substring hits like description terms, by name on ties, capped at five', () => {
    const shared = ['f6', 'b2', 'e5', 'a1', 'd4', 'c3'].map(name => tool(name, `会话工具 ${name}`))
    expect(searchDeferredTools('会话', shared).map(t => t.name)).toEqual(['a1', 'b2', 'c3', 'd4', 'e5'])

    const tied = [tool('beta_tool', '会话广播'), tool('alpha_tool', 'send a message')]
    expect(searchDeferredTools('message 广播', tied).map(t => t.name)).toEqual(['alpha_tool', 'beta_tool'])
    const swapped = [tool('alpha_tool', '会话广播'), tool('beta_tool', 'send a message')]
    expect(searchDeferredTools('message 广播', swapped).map(t => t.description)).toEqual(['会话广播', 'send a message'])
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

  it('ends a catalog line at a full-width sentence terminator', async () => {
    const ctx = await mount(['de_*'])
    ctx.tools.register(tool('de_broadcast', '会话广播：会话之间传递消息。send：给其他会话发消息'))
    ctx.tools.register(tool('de_rules', 'Use v1.2 rules. Tail.'))
    const { key } = await mintAgent(ctx, 'full-width')

    const search = ctx.tools.schemas(key).find(schema => schema.name === TOOL_SEARCH_NAME)!
    expect(search.description).toContain('- de_broadcast: 会话广播：会话之间传递消息。')
    expect(search.description).not.toContain('send：')
    expect(search.description).toContain('- de_rules: Use v1.2 rules.')
    expect(search.description).not.toContain('Tail.')
  })

  it('summarizes each catalog line to its first sentence, capped', async () => {
    const cases: Array<[description: string, line: string]> = [
      ['第一句！第二句', '第一句！'],
      ['能用吗？后文', '能用吗？'],
      ['读取 config.yaml 文件。后文 more.', '读取 config.yaml 文件。'],
      ['Broadcast a message. More.', 'Broadcast a message.'],
      ['Stop! Next', 'Stop!'],
      ['Why? Because', 'Why?'],
      ['No terminator here', 'No terminator here'],
      ['会话广播。', '会话广播。'],
      ['甲。 乙', '甲。'],
      ['First line without end\nSecond line. More', 'First line without end'],
      [`${'长'.repeat(130)}。后文`, `${'长'.repeat(119)}…`],
      ['', ''],
      ['。', '。'],
    ]
    const name = (index: number): string => `de_case${String(index).padStart(2, '0')}`
    const ctx = await mount(['de_*'])
    cases.forEach(([description], index) => { ctx.tools.register(tool(name(index), description)) })
    const { key } = await mintAgent(ctx, 'summaries')

    const lines = ctx.tools.schemas(key).find(schema => schema.name === TOOL_SEARCH_NAME)!.description.split('\n')
    expect(cases.map((_, index) => lines.find(line => line.startsWith(`- ${name(index)}: `))))
      .toEqual(cases.map(([, line], index) => `- ${name(index)}: ${line}`))
  })

  it('reveals searched tools durably and appends their schemas after the existing ones', async () => {
    // Exact-name patterns are one-tool groups, so each search reveals only its hit.
    const ctx = await mount(['de_broadcast', 'de_session'])
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

  it('reveals a tool found by a Chinese query through tool_search', async () => {
    const ctx = await mount(['de_broadcast', 'dtodo'])
    ctx.tools.register(tool('de_broadcast', '会话广播：DSH 会话之间传递消息'))
    ctx.tools.register(tool('dtodo', '待办管理（四轨：life 生活 / work 工作）'))
    const { key } = await mintAgent(ctx, 'chinese')

    expect(await run(ctx, TOOL_SEARCH_NAME, key, { query: '广播' })).toContain('Revealed 1 tool(s): de_broadcast')
    expect(key.session.snapshotEvents().filter(event => event.type === 'tools/reveal').map(event => event.data))
      .toEqual([{ names: ['de_broadcast'] }])
    expect(await run(ctx, 'de_broadcast', key)).toBe('ran:de_broadcast')
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

  it('reveals a whole group per search so the declared list changes once per family', async () => {
    const ctx = await mount(['de_ws_*', 'de_*', '!de_session', 'mcp__*'])
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('de_session', 'Spawn or wake a session.'))
    ctx.tools.register(tool('de_ws_status', 'Workspace occupancy status.'))
    ctx.tools.register(tool('de_ws_declare', 'Declare workspace occupancy.'))
    ctx.tools.register(tool('de_broadcast', 'Broadcast a message.'))
    ctx.tools.register(tool('mcp__kimi-cu__click', 'Click a point.'))
    ctx.tools.register(tool('mcp__kimi-cu__scroll', 'Scroll a window.'))
    ctx.tools.register(tool('mcp__lark__doc', 'Read a Feishu document.'))
    const { key } = await mintAgent(ctx, 'groups')

    // The excluded name stays declared directly.
    expect(names(ctx, key)).toEqual(['read', 'de_session', TOOL_SEARCH_NAME])

    // One hit on de_ws_status reveals its sibling, but not the broader de_* group.
    const text = await run(ctx, TOOL_SEARCH_NAME, key, { query: 'de_ws_status' })
    expect(text).toContain('Revealed 2 tool(s): de_ws_status, de_ws_declare')
    expect(key.session.snapshotEvents().filter(event => event.type === 'tools/reveal').map(event => event.data))
      .toEqual([{ names: ['de_ws_status', 'de_ws_declare'] }])
    expect(names(ctx, key)).toEqual(['read', 'de_session', 'de_ws_status', 'de_ws_declare', TOOL_SEARCH_NAME])

    // MCP tools reveal per server.
    await run(ctx, TOOL_SEARCH_NAME, key, { query: 'click' })
    expect(names(ctx, key)).toContain('mcp__kimi-cu__scroll')
    expect(names(ctx, key)).not.toContain('mcp__lark__doc')
  })
})
