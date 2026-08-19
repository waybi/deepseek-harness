/** Session-delete boundaries: unknown ids, descendants, and owned-handle teardown. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`delete-${String(nextRpc++)}`), payload }
}

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: sid(id), createdAt: 1, cwd: '/proj', ...extra }
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const publish = (ownerCtx: Context, id: SessionId, seed?: readonly SessionEvent[], meta?: CreateAgentOptions['meta']): AgentHandle => {
    const session = ctx.sessions.create(id, {
      ...seed === undefined ? {} : { seed: [...seed] },
      ...meta === undefined ? {} : { meta },
    })
    const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
    const disposeAgent = ctx.agents.register(agent)
    return { agent, dispose: async () => { disposeAgent() } }
  }
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> =>
      Promise.resolve(publish(ownerCtx, options.sessionId, options.seed, options.meta)),
    resume: async (ownerCtx: Context, options: { resumeSessionId: SessionId }): Promise<AgentHandle> => {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('no persistence')
      const inspected = await persistence.inspect(options.resumeSessionId)
      return publish(ownerCtx, options.resumeSessionId, inspected.events, {
        ...inspected.meta.cwd === undefined ? {} : { cwd: inspected.meta.cwd },
      })
    },
  })
  return ctx
}

function liveAgent(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
})

describe('sessions.delete', () => {
  it('rejects an unknown session', async () => {
    const ctx = await composed()
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([]),
      delete: () => Promise.reject(new Error('must not delete')),
    } as never)
    const response = await api(ctx).sessions.delete(request({ sessionId: sid('ghost') }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    await ctx.fiber.dispose()
  })

  it('rejects a non-recursive delete that still has descendants', async () => {
    const ctx = await composed()
    const parent = header('parent')
    const child = header('child', { parentSession: parent.id })
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([parent, child]),
      delete: () => Promise.reject(new Error('must not delete')),
    } as never)
    const response = await api(ctx).sessions.delete(request({ sessionId: parent.id }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-has-descendants', details: { sessionId: 'parent', descendantIds: ['child'] } },
    })
    await ctx.fiber.dispose()
  })

  it('deletes a cold session and its descendants', async () => {
    const ctx = await composed()
    const parent = header('parent')
    const child = header('child', { parentSession: parent.id })
    const removed: SessionId[] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([parent, child]),
      delete: (id: SessionId) => {
        removed.push(id)
        return Promise.resolve()
      },
    } as never)
    const response = await api(ctx).sessions.delete(request({
      sessionId: parent.id, recursive: true,
    }))
    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(removed).toEqual([child.id, parent.id])
    await ctx.fiber.dispose()
  })

  it('disposes an owned live session before deleting its log', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const created = await proxy.sessions.create(request({ sessionId: sid('live') }))
    expect(created.result.ok).toBe(true)
    const removed: SessionId[] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header('live')]),
      delete: (id: SessionId) => {
        removed.push(id)
        return Promise.resolve()
      },
    } as never)
    const response = await proxy.sessions.delete(request({ sessionId: sid('live') }))
    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(ctx.agents.get(sid('live'))).toBeUndefined()
    expect(removed).toEqual([sid('live')])
    await ctx.fiber.dispose()
  })

  it('deletes a session the read path resumed through the shared resolver', async () => {
    const ctx = await composed()
    const stored = header('cold')
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const removed: SessionId[] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([stored]),
      inspect: () => Promise.resolve({ meta: stored, events }),
      delete: (id: SessionId) => {
        removed.push(id)
        return Promise.resolve()
      },
    } as never)
    const proxy = api(ctx)
    // Renaming resolves the identity through the shared resolver, which
    // resumes the cold session and hands its handle to this gateway.
    await proxy.sessions.rename(request({ sessionId: stored.id, title: 'kept' }))
    expect(ctx.agents.get(stored.id)).not.toBeUndefined()

    const response = await proxy.sessions.delete(request({ sessionId: stored.id }))
    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(ctx.agents.get(stored.id)).toBeUndefined()
    expect(removed).toEqual([stored.id])
    await ctx.fiber.dispose()
  })

  it('refuses a live session this host does not own', async () => {
    const ctx = await composed()
    const session = liveAgent(ctx, 'unowned')
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([session.header]),
      delete: () => Promise.reject(new Error('must not delete')),
    } as never)
    const response = await api(ctx).sessions.delete(request({ sessionId: session.id }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'agent-busy', details: { reason: 'no-owned-handle' } },
    })
    expect(ctx.sessions.get(session.id)).toBe(session)
    await ctx.fiber.dispose()
  })
})
