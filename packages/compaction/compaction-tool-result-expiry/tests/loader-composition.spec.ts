import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ToolResultExpiry, { expiredStub } from '@deepseek-ai/dsh-compaction-tool-result-expiry'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Loader module source that resolves only the listed specifiers; every other hook is unreachable in this suite. */
function moduleLoaderStub(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unreachable = (name: string) => (): never => {
    throw new Error(`moduleLoaderStub: ${name} is not exercised by this suite`)
  }
  return {
    version: 'v2',
    loadCache: new Map() as ModuleLoaderV2['loadCache'],
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register: unreachable('register'),
    getOrCreateModuleJob: unreachable('getOrCreateModuleJob'),
    resolveSync: unreachable('resolveSync'),
    load: unreachable('load'),
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, size: number): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const args = JSON.stringify({ size })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'dump', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'dump', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Replies one scripted stream per request and records every request. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    yield * entry
  }
}

function toolTexts(request: GenerateOptions): string[] {
  return request.messages
    .filter(message => message.role === 'tool')
    .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('compaction-tool-result-expiry real Loader composition', () => {
  it('loads and resolves the flat YAML plugin shape', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-compact-tool-result-expiry-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-expiry'",
      '  config:',
      '    coldTurns: 2',
      '    thresholdChars: 30',
      '',
    ].join('\n'))

    const context = new Context()
    contexts.push(context)
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = moduleLoaderStub(new Map<string, unknown>([
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-token-meter', TokenMeter],
      ['@deepseek-ai/dsh-compaction-tool-result-expiry', ToolResultExpiry],
    ]))
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.get('toolResultExpiry')).toBeInstanceOf(ToolResultExpiry)
    expect(context.toolResultExpiry.config).toEqual({ coldTurns: 2, thresholdChars: 30 })
  })

  it('rejects stale config after plugin schema normalization', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(ToolResultExpiry, {
      headChars: 100,
    } as never)).rejects.toThrow(/unknown key "headChars"/)
  })

  it('stubs cold oversized tool output in the request the production loop sends', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('c1', 600), textResponse('turn 1 done'),
      textResponse('turn 2 done'),
      textResponse('turn 3 done'),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ToolResultExpiry, { coldTurns: 2, thresholdChars: 30 })
    const loop = await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'dump',
      description: 'dump bytes',
      parameters: { size: { type: 'number' } },
      async execute(args) {
        return [{ type: 'text', text: 'x'.repeat(args.size as number) }]
      },
    }))
    const agent = await loop.create(SessionId('expire-loop'), { provider: 'mock', model: 'mock' })

    for (const text of ['dump it', 'again', 'once more']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
    }

    // Request 2 (turn 1, after the tool) and request 3 (turn 2) carry the verbatim
    // result; request 4 (turn 3, two turns later) carries the stub.
    expect(adapter.requests).toHaveLength(4)
    expect(toolTexts(adapter.requests[1]!)).toEqual(['x'.repeat(600)])
    expect(toolTexts(adapter.requests[2]!)).toEqual(['x'.repeat(600)])
    expect(toolTexts(adapter.requests[3]!)).toEqual([expiredStub('dump', 600)])

    // The leading messages up to the stubbed result are byte-identical across
    // requests 3 and 4, so a provider prefix cache keeps matching there.
    const head = (request: GenerateOptions) => JSON.stringify(request.messages.slice(0, 3))
    expect(head(adapter.requests[3]!)).toBe(head(adapter.requests[2]!))

    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types.filter(type => type === 'compaction/prune')).toHaveLength(1)
  })
})
