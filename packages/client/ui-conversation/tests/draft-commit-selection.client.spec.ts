// @vitest-environment jsdom
/** The caret after a committed send stays inside an editable paragraph, so the next IME composition lands there. */
import { Context } from '@deepseek-ai/cordis'
import { fireEvent } from '@testing-library/react'
import {
  $getRoot, $getSelection, $isParagraphNode, $isRangeSelection, $isTextNode,
} from 'lexical'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'

function mountedRuntime(): { runtime: DraftEditorRuntime; root: HTMLElement } {
  // jsdom has no Range geometry; Lexical's caret scroll reads it after a focused update.
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
  })
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  document.body.append(root)
  onTestFinished(() => { root.remove() })
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection() },
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  onTestFinished(dispose)
  runtime.editor.setRootElement(root)
  root.focus()
  return { runtime, root }
}

function caret(runtime: DraftEditorRuntime) {
  return runtime.editor.getEditorState().read(() => {
    const root = $getRoot()
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return { range: false as const, children: root.getChildrenSize() }
    const anchor = selection.anchor.getNode()
    return {
      range: true as const,
      collapsed: selection.isCollapsed(),
      children: root.getChildrenSize(),
      anchorIsRoot: anchor.is(root),
      anchorType: anchor.getType(),
      anchorOffset: selection.anchor.offset,
      anchorParagraphText: (($isParagraphNode(anchor) ? anchor : anchor.getParent())?.getTextContent()) ?? null,
      anchorText: $isTextNode(anchor) ? anchor.getTextContent() : null,
      firstChildEmptyParagraph: (() => {
        const first = root.getFirstChild()
        return $isParagraphNode(first) && first.getChildrenSize() === 0
      })(),
    }
  })
}

/** jsdom has no IME: drive Lexical's composition listeners and insert the committed text at the live selection. */
function compose(runtime: DraftEditorRuntime, root: HTMLElement, text: string): void {
  fireEvent.compositionStart(root, { data: '' })
  runtime.editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) throw new Error('composition started without a range selection')
    selection.insertText(text)
  }, { discrete: true })
  fireEvent.compositionEnd(root, { data: text })
  runtime.editor.read(() => {})
}

it('leaves one empty paragraph holding a collapsed caret after a full clear', () => {
  const { runtime } = mountedRuntime()
  runtime.setDraft('第一条消息')
  runtime.clearCommittedDraft(() => null)
  expect(caret(runtime)).toMatchObject({
    range: true, collapsed: true, children: 1, firstChildEmptyParagraph: true,
    anchorIsRoot: false, anchorType: 'paragraph', anchorOffset: 0,
  })
})

it('collapses the caret at the start of a retained typed-during-flight suffix', () => {
  const { runtime } = mountedRuntime()
  runtime.setDraft('sent tail')
  runtime.clearCommittedDraft(clip => clip.startsWith('sent ') ? 'sent '.length : null)
  expect(runtime.projection.clipboardText).toBe('tail')
  expect(caret(runtime)).toMatchObject({
    range: true, collapsed: true, children: 1, anchorIsRoot: false,
    anchorType: 'text', anchorText: 'tail', anchorOffset: 0,
  })
})

it('places the next IME composition inside the cleared paragraph', () => {
  const { runtime, root } = mountedRuntime()
  runtime.setDraft('第一条消息')
  runtime.clearCommittedDraft(() => null)
  // A browser IME starts composing at the DOM caret: it must sit inside the paragraph, not on the bare host.
  const domCaret = document.getSelection()!
  expect(domCaret.isCollapsed).toBe(true)
  expect(domCaret.anchorNode?.nodeName).toBe('P')
  expect(domCaret.anchorNode?.parentNode).toBe(root)
  expect(domCaret.anchorOffset).toBe(0)
  compose(runtime, root, '你好')
  expect(runtime.projection.clipboardText).toBe('你好')
  expect(root.textContent).toBe('你好')
  expect(caret(runtime)).toMatchObject({
    range: true, children: 1, anchorIsRoot: false, anchorType: 'text',
    anchorText: '你好', anchorParagraphText: '你好',
  })
  expect(runtime.editor.getEditorState().read(() => {
    const selection = $getSelection()
    return $isRangeSelection(selection) && selection.anchor.key === selection.focus.key ? selection.focus.offset : -1
  })).toBe('你好'.length)
})

it('keeps the caret in an empty paragraph after a real submit through the input shell', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const shell = new SessionInputShell({
    actx: ctx,
    defaultSink: sink,
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
  })
  onTestFinished(() => { shell.dispose() })
  shell.setDraft({ text: '第一条消息', references: [] })
  shell.submit()
  await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(1) })
  expect(shell.draftSnapshot).toEqual({ text: '', references: [] })
  const state = shell.editor.getEditorState().read(() => {
    const selection = $getSelection()
    const first = $getRoot().getFirstChild()
    return {
      children: $getRoot().getChildrenSize(),
      emptyParagraph: $isParagraphNode(first) && first.getChildrenSize() === 0,
      range: $isRangeSelection(selection),
      anchorIsRoot: $isRangeSelection(selection) && selection.anchor.getNode().is($getRoot()),
    }
  })
  expect(state).toEqual({ children: 1, emptyParagraph: true, range: true, anchorIsRoot: false })
})
