/**
 * The two pure folds of round-age image hydration: which blocks one durable
 * `image/rehydrate` decision rewrites, which malformed decisions it refuses,
 * and which nodes the surface index tracks.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { imagePlaceholder, imageRehydrateProjection, imageSurfaceProjection } from '../src/index.ts'
import type { ImageSurfaceState } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function imageAttachment(name: string): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${name.padEnd(64, '0')}` as ImageAttachmentRef['attachmentId'],
    name,
    mediaType: 'image/png',
    bytes: 128,
    width: 1,
    height: 1,
  }
}

function image(name: string): ImageBlock {
  return { type: 'image', attachment: imageAttachment(name) }
}

/** A session store with the `image/rehydrate` projection registered, as the mounted plugin does. */
async function mount(id: string): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  ctx.sessions.registerMessageProjection(imageRehydrateProjection)
  return { ctx, session: ctx.sessions.create(SessionId(id)) }
}

/** Fold one session's log through the surface index, as the mounted service does. */
function indexOf(session: Session): ImageSurfaceState {
  return session.snapshotEvents().reduce(
    (state, event: SessionEvent) => imageSurfaceProjection.apply(state, event),
    imageSurfaceProjection.init(),
  )
}

describe('image/rehydrate projection', () => {
  it('replaces exactly the named occurrences and preserves message identity', async () => {
    const { session } = await mount('rewrite')
    const seeded = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before' }, image('one'), image('two')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    session.append('image/rehydrate', {
      targets: [{ seq: seeded.seq, images: [{ imageIndex: 1, path: '/tmp/two.png' }] }],
    })

    const [message] = session.deriveMessages()
    expect(message!.id).toBe(seeded.data.id)
    expect(message!.content).toHaveLength(3)
    expect(message!.content[1]).toEqual(image('one'))
    expect(message!.content[2]).toEqual({ type: 'text', text: imagePlaceholder(imageAttachment('two'), '/tmp/two.png') })
    // The durable event still carries both occurrences.
    expect(session.snapshotEvents()[0]).toMatchObject({ type: 'user/message' })
  })

  it('refuses a decision that names no current node or a malformed occurrence list', async () => {
    const { session } = await mount('refusals')
    const seeded = session.append('user/message', createUserMessage({
      content: [image('one'), image('two')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const absent = SessionSeq(99)
    const seq = seeded.seq

    expect(() => session.append('image/rehydrate', { targets: [{ seq: absent, images: [{ imageIndex: 0, path: '/a' }] }] }))
      .toThrow(/is not a current surface node/u)
    expect(() => session.append('image/rehydrate', { targets: [{ seq, images: [] }] }))
      .toThrow(/names no images/u)
    expect(() => session.append('image/rehydrate', { targets: [{ seq, images: [{ imageIndex: 1, path: '/a' }, { imageIndex: 0, path: '/b' }] }] }))
      .toThrow(/must strictly increase/u)
    expect(() => session.append('image/rehydrate', { targets: [{ seq, images: [{ imageIndex: 5, path: '/a' }] }] }))
      .toThrow(/does not exist/u)
    expect(() => session.append('image/rehydrate', { targets: [{ seq, images: [{ imageIndex: 0, path: '' }] }] }))
      .toThrow(/nonempty path/u)
  })

  it('refuses to replace an occurrence the offload decision already omitted', async () => {
    const { session } = await mount('offloaded')
    const seeded = session.append('user/message', createUserMessage({
      content: [image('one')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('image/offload', { targets: [{ seq: seeded.seq, imageIndexes: [0] }] })

    expect(() => session.append('image/rehydrate', {
      targets: [{ seq: seeded.seq, images: [{ imageIndex: 0, path: '/tmp/one.png' }] }],
    })).toThrow(/already offloaded/u)
  })

  it('leaves later messages untouched', async () => {
    const { session } = await mount('later')
    const seeded = session.append('user/message', createUserMessage({
      content: [image('one')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('image/rehydrate', { targets: [{ seq: seeded.seq, images: [{ imageIndex: 0, path: '/tmp/one.png' }] }] })
    session.append('user/message', createUserMessage({
      content: [image('two')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const messages = session.deriveMessages()
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text' })
    expect(messages[1]!.content[0]).toEqual(image('two'))
  })
})

describe('imageSurface projection', () => {
  it('records the latest turn and the image-capable nodes', async () => {
    const { session } = await mount('surface')
    session.append('turn/start', { turn: 3 })
    const user = session.append('user/message', createUserMessage({
      content: [image('one')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = session.append('tool/result', {
      turn: 3,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [image('two')], isError: false }),
    }, { surfaceOp: 'append' })

    const state = indexOf(session)
    expect(state.turn).toBe(3)
    expect(state.nodes).toEqual([
      { seq: user.seq, messageId: user.data.id, turn: 3 },
      { seq: result.seq, messageId: result.data.message.id, turn: 3 },
    ])
  })

  it('drops shadowed nodes and keeps the replacement node', async () => {
    const { session } = await mount('replace')
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [image('one')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })
    const summary = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] })

    const state = indexOf(session)
    expect(state.turn).toBe(2)
    expect(state.nodes).toEqual([{ seq: summary.seq, messageId: summary.data.id, turn: 2 }])
  })

  it('keeps the same state reference for events it does not track', async () => {
    const { session } = await mount('untracked')
    const initial = indexOf(session)
    session.append('todo/write', { todos: [] })
    const afterTodo = indexOf(session)
    expect(afterTodo.nodes).toEqual(initial.nodes)
  })
})
