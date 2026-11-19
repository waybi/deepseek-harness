import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerSessionMenus } from '../src/client/session-actions/context-menus.tsx'
import { en, zh } from '../src/client/locales.ts'

type SessionRows = { byId: Record<string, { cwd?: string }> }

function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new MenuRegistry(vi.fn())
  onTestFinished(() => { registry.dispose() })
  ctx.provide('contextMenus', { register: registry.register.bind(registry) } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register('workspace', { en, zh }); locale.setLocale('en')
  const list = createSnapshotStore<WorkspaceSnapshot>({
    items: [], pinnedSessionIds: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  ctx.provide('workspaces', { list } as never)
  const sessions = createSnapshotStore<SessionRows>({ byId: {} })
  ctx.provide('sessions', { list: sessions } as never)
  const permissions = new Map<string, ReturnType<typeof createSnapshotStore<boolean>>>()
  const access = (action: string) => {
    let source = permissions.get(action)
    if (source === undefined) { source = createSnapshotStore(true); permissions.set(action, source) }
    return source
  }
  ctx.provide('remoteAccess', { source: (_kind: string, _id: string, action: string) => access(action) } as never)
  const actions = { pinSession: vi.fn(), unpinSession: vi.fn(), archiveSession: vi.fn(), unarchiveSession: vi.fn(),
    forkSession: vi.fn(), requestSessionRename: vi.fn(), copySessionId: vi.fn(async () => {}), deleteSession: vi.fn() }
  const fiber = ctx.plugin({ apply: (plugin: Context) => {
    registerSessionMenus(plugin, actions)
    // Stand in for the ui-open-in-app row so the integrated top-level order is asserted here.
    plugin.effect(() => plugin.contextMenus.register({
      id: 'open-in-app.reveal', target: 'session', order: 500,
      resolve: () => [{ id: 'reveal', label: 'Show in folder', icon: { key: 'open-in-app.reveal' } }],
    }), 'stub session reveal')
  } })
  const target = { kind: 'session' as const, value: { sessionId: SessionId('background'), displayTitle: 'Background' } }
  const open = () => registry.resolve(target)
  return { ctx, fiber, registry, locale, list, sessions, access, actions, target, open }
}

it('orders the seven session rows and binds the More submenu to the captured Session', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.open()
  const views = menu.source.getSnapshot()
  expect(views.map(({ id, label, commandId, separatorBefore, danger }) =>
    [id, label, commandId, separatorBefore, danger])).toEqual([
    ['session.pin/pin', 'Pin session', 'session.pin', undefined, undefined],
    ['session.rename/rename', 'Rename', 'session.rename', undefined, undefined],
    ['session.id/copy', 'Copy Session ID', undefined, undefined, undefined],
    ['session.archive/archive', 'Archive session', 'session.archive', true, undefined],
    ['session.delete/delete', 'Delete session', undefined, undefined, true],
    ['open-in-app.reveal/reveal', 'Show in folder', undefined, undefined, undefined],
    ['session.more/more', 'More', undefined, true, undefined],
  ])
  const more = views.at(-1)!
  expect(more.children?.map(({ id, label, disabled }) => [id, label, disabled])).toEqual([
    ['session.more/more/continueInNew', 'Continue in new session', undefined],
    ['session.more/more/copyWorkingDirectory', 'Copy working directory', true],
  ])
  menu.dispose()
  for (const id of views.map(item => item.id)) b.open().select(id)
  expect(b.actions.pinSession).toHaveBeenCalledWith('background')
  expect(b.actions.requestSessionRename).toHaveBeenCalledWith('background', 'Background')
  expect(b.actions.copySessionId).toHaveBeenCalledWith('background')
  expect(b.actions.archiveSession).toHaveBeenCalledWith('background')
  expect(b.actions.deleteSession).toHaveBeenCalledWith('background')
  b.open().select('session.more/more/continueInNew')
  expect(b.actions.forkSession).toHaveBeenCalledWith('background')
  const unpin = b.open()
  b.list.set({ ...b.list.getSnapshot(), pinnedSessionIds: [b.target.value.sessionId] })
  expect(unpin.source.getSnapshot()[0]).toMatchObject({ label: 'Unpin session' })
  expect(unpin.source.getSnapshot()[0]?.commandId).toBeUndefined()
  unpin.select('session.pin/pin')
  expect(b.actions.unpinSession).toHaveBeenCalledWith('background')
  const restore = b.open()
  b.list.set({ ...b.list.getSnapshot(), archivedSessionIds: [b.target.value.sessionId] })
  expect(restore.source.getSnapshot().some(item => item.id === 'session.pin/pin')).toBe(false)
  const archive = restore.source.getSnapshot().find(item => item.id === 'session.archive/archive')!
  expect(archive).toMatchObject({ label: 'Unarchive session' })
  expect(archive.commandId).toBeUndefined()
  restore.select(archive.id)
  expect(b.actions.unarchiveSession).toHaveBeenCalledWith('background')
})

it('disables copying a Session without a cwd and writes the Session cwd when present', async () => {
  const b = bench()
  await b.fiber.await()
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  onTestFinished(() => { vi.unstubAllGlobals() })
  expect(b.open().source.getSnapshot().at(-1)?.children?.[1]).toMatchObject({
    id: 'session.more/more/copyWorkingDirectory', label: 'Copy working directory', disabled: true,
  })
  b.sessions.set({ byId: { background: { cwd: '/work/sidebar' } } })
  const enabled = b.open()
  const copy = enabled.source.getSnapshot().at(-1)?.children?.[1]
  expect(copy).toMatchObject({
    id: 'session.more/more/copyWorkingDirectory', label: 'Copy working directory', disabled: false,
  })
  enabled.select(copy!.id)
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/sidebar'))
})

it('reacts to permission and locale updates, prevents withdrawn actions, and disposes subscriptions', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.open()
  b.access('session/rename').set(false)
  b.access('session/fork').set(false)
  b.access('workspace/archiveSession').set(false)
  b.access('workspace/pinSession').set(false)
  b.access('workspace/deleteSession').set(false)
  expect(menu.source.getSnapshot().map(item => item.id)).toEqual([
    'session.id/copy', 'open-in-app.reveal/reveal', 'session.more/more',
  ])
  expect(menu.source.getSnapshot().at(-1)?.children?.map(child => child.id)).toEqual([
    'session.more/more/copyWorkingDirectory',
  ])
  menu.select('session.rename/rename')
  expect(b.actions.requestSessionRename).not.toHaveBeenCalled()
  b.locale.setLocale('zh')
  expect(menu.source.getSnapshot()[0]?.label).toBe('复制对话 ID')
  expect(menu.source.getSnapshot().at(-1)?.label).toBe('更多')
  expect(menu.source.getSnapshot().at(-1)?.children?.map(child => child.label)).toEqual(['复制工作目录'])
  b.access('session/rename').set(true)
  expect(menu.source.getSnapshot()[0]?.label).toBe('重命名')
  await b.fiber.dispose()
  expect(menu.source.getSnapshot()).toEqual([])
  b.access('session/rename').set(false)
  b.list.set({ ...b.list.getSnapshot(), pinnedSessionIds: [] })
  menu.select('session.id/copy')
  expect(b.actions.copySessionId).not.toHaveBeenCalled()
  expect(menu.source.getSnapshot()).toEqual([])
  menu.dispose()
})
