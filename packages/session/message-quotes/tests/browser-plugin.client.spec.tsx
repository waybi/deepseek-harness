// @vitest-environment jsdom
/** Quote registrations follow their plugin and Slot declaration lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/client/index.ts'

async function fixture() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  const sessionId = await sessions.add({ id: 'quote' })
  sessions.retainFor(ctx, sessionId)
  ctx.provide('sessions', sessions)
  const conversation = new UiConversation(ctx, sessions)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const declareSlots = () => ctx.slots.register({
    name: 'root',
    children: {
      'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true },
    },
  } as never, (() => null) as never)
  return { ctx, conversation, fiber, declareSlots }
}

describe('Quote browser plugin', () => {
  it('mounts with late Slot declarations, reattaches after their replacement, and releases every contribution', async () => {
    const { ctx, conversation, fiber, declareSlots } = await fixture()
    const evaluate = conversation.userText.createEvaluator()
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('quote')
    const firstDeclaration = declareSlots()
    expect(ctx.slots.entries('conversation.user.text.node').map(entry => entry.options.key)).toEqual(['quote'])
    firstDeclaration()
    const replacement = declareSlots()
    expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(1)

    await fiber.dispose()
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('text')
    expect(ctx.slots.entries('conversation.user.text.node')).toEqual([])

    await ctx.plugin(plugin).await()
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('quote')
    expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(1)
    replacement()
  })
})
