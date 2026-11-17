/** Literal UserText excerpt rendering registered by the browser plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { QuotedUserText } from './QuotedUserText.tsx'
import { quoteRule } from './quote-rule.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh, type MessageQuotesKey } from './locales.ts'

export type {} from './quote-rule.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Quote dictionaries kept for the blockquote rendering rule. */
    messageQuotes: MessageQuotesKey
  }
}

/** Browser plugin name. */
export const name = 'message-quotes'

/** Services needed to register Quote presentation. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Register literal UserText rendering for quoted excerpts.
 * @param ctx - Client root context owning every Quote contribution.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'message-quotes: dictionaries')
  ctx.effect(() => ctx.uiConversation.userText.register(quoteRule), 'message-quotes: UserText rule')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'quote', priority: 100,
  }, QuotedUserText))
}
