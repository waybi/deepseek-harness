/**
 * Round-age image hydration in the production loop: recent rounds keep their
 * image bytes, older ones become a placeholder naming the stored copy, and the
 * durable log keeps every original image.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as offload from '@deepseek-ai/dsh-compaction-image-offload'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { foldSurface, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ImageRehydrate, { imagePlaceholder, imageRehydrateProjection } from '../src/index.ts'

/** A valid 1x1 PNG; the attachment provider normalizes and verifies it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==',
  'base64',
)

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Replies one scripted stream per request and records every request. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly replies: string[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.replies.shift() ?? 'ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly ref: ImageAttachmentRef
  readonly path: string
}

async function harness(options: { retainRounds?: number; enabled?: boolean; withOffload?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-rehydrate-'))
  roots.push(root)
  const adapter = new ScriptedAdapter(Array.from({ length: 8 }, (_, index) => `reply ${index}`))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FileSystem, { cwd: root })
  await ctx.plugin(LocalAttachments, { dshHome: join(root, 'home') })
  await mountAgentLoopTestDependencies(ctx)
  if (options.withOffload === true) await ctx.plugin(offload)
  await ctx.plugin(ImageRehydrate, {
    ...options.retainRounds === undefined ? {} : { retainRounds: options.retainRounds },
    ...options.enabled === undefined ? {} : { enabled: options.enabled },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const ref = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'diagram.png' })
  const path = ctx.imageRehydrate.imagePath(ref)
  if (path === undefined) throw new Error('the mounted composition exposes no attachment path')
  const agent = await ctx.agentLoop.create(SessionId(`rehydrate-${roots.length}`), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent, ref, path }
}

function imagesOf(request: GenerateOptions): ImageBlock[] {
  return request.messages.flatMap(message => message.content.filter((block): block is ImageBlock => block.type === 'image'))
}

function textOf(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'))
    .map(block => block.text)
    .join('\n')
}

/** The surface seq of one durable message, read from the test-only log snapshot. */
function seqOfMessage(session: Session, messageId: string): SessionSeq {
  const event = session.snapshotEvents().find(candidate =>
    (candidate.type === 'user/message' && candidate.data.id === messageId)
    || (candidate.type === 'tool/result' && candidate.data.message.id === messageId))
  if (event === undefined) throw new Error(`no durable message ${messageId}`)
  return event.seq
}

/** One turn of plain user text. */
async function turn(harnessed: Harness, text: string): Promise<void> {
  harnessed.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await harnessed.agent.whenIdle()
}

describe('compaction-image-rehydrate', () => {
  it('replaces images older than the retained rounds and keeps the recent ones', async () => {
    const harnessed = await harness({ retainRounds: 2 })
    const { adapter, agent, ref, path } = harnessed

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'first' }, { type: 'image', attachment: ref }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await turn(harnessed, 'second')
    await turn(harnessed, 'third')

    // Turn 1 keeps its image, turn 2 still sees it (age 1 < 2), turn 3 does not.
    expect(adapter.requests).toHaveLength(3)
    expect(imagesOf(adapter.requests[0]!)).toHaveLength(1)
    expect(imagesOf(adapter.requests[1]!)).toHaveLength(1)
    expect(imagesOf(adapter.requests[2]!)).toHaveLength(0)
    expect(textOf(adapter.requests[2]!)).toContain(imagePlaceholder(ref, path))

    // The durable log keeps the original image; only the request face changed.
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    if (original?.type !== 'user/message') throw new Error('no durable user message')
    expect(original.data.content.some(block => block.type === 'image')).toBe(true)
    const decisions = agent.session.snapshotEvents().filter(event => event.type === 'image/rehydrate')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.data.targets)
      .toEqual([{ seq: seqOfMessage(agent.session, original.data.id), images: [{ imageIndex: 0, path }] }])
  })

  it('leaves every image in place when hydration is disabled', async () => {
    const harnessed = await harness({ enabled: false })
    const { adapter, agent, ref } = harnessed

    agent.followup(createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await turn(harnessed, 'second')
    await turn(harnessed, 'third')

    expect(adapter.requests).toHaveLength(3)
    for (const request of adapter.requests) expect(imagesOf(request)).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'image/rehydrate')).toHaveLength(0)
  })

  it('replays the same request face from the log', async () => {
    const harnessed = await harness({ retainRounds: 1 })
    const { adapter, agent, ref, path } = harnessed
    agent.followup(createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await turn(harnessed, 'second')

    // A detached replay folds the same log through the same projection and
    // reproduces the rehydrated message byte for byte.
    const events = agent.session.snapshotEvents()
    const replay = foldSurface(events, [imageRehydrateProjection])
    const derived = agent.session.deriveMessages()
    const rehydrated = derived.find(message =>
      message.content.some(block => block.type === 'text' && block.text.includes(path)))
    expect(rehydrated).toBeDefined()
    const deferred = [...replay.projectedMessages.values()].find(message => message.id === rehydrated!.id)
    expect(JSON.stringify(deferred)).toBe(JSON.stringify(rehydrated))
    expect(imagesOf(adapter.requests[1]!)).toHaveLength(0)

    // Re-deriving changes nothing: the decision is durable, not per-call state.
    expect(JSON.stringify(agent.session.deriveMessages())).toBe(JSON.stringify(derived))
  })

  it('keeps a later image-offload decision working on retained images', async () => {
    const harnessed = await harness({ retainRounds: 2, withOffload: true })
    const { agent, ref, path } = harnessed
    agent.followup(createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await turn(harnessed, 'third')

    // Turn 1 was rehydrated; turn 2's image survives, so the passive offload
    // decision still marks it on the surface.
    const withImages = agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.content.some(block => block.type === 'image'))
    expect(withImages).toHaveLength(2)
    const retained = withImages[1]
    if (retained?.type !== 'user/message') throw new Error('no durable user message')
    const seq = seqOfMessage(agent.session, retained.data.id)
    agent.session.append('image/offload', { targets: [{ seq, imageIndexes: [0] }] })

    const after = agent.session.deriveMessages()
    const offloaded = after.flatMap(message => message.content)
      .filter((block): block is ImageBlock => block.type === 'image')
    expect(offloaded).toHaveLength(1)
    expect(offloaded[0]!.offloaded).toBe(true)
    expect(JSON.stringify(after)).toContain(path)
  })
})
