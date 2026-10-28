// @vitest-environment jsdom
import { Buffer } from 'node:buffer'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeSessionReferenceUri } from '../../../context/session-reference/src/uri.ts'
import { MarkdownDelegateProvider } from '../src/index.ts'
import { parseSessionLink } from '../src/markdown/session-link.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const ID = 'session-0c880d5a-52ec-45f4-b0f5-5578d70e540a'
const URI = 'dsh-session:InNlc3Npb24tMGM4ODBkNWEtNTJlYy00NWY0LWIwZjUtNTU3OGQ3MGU1NDBhIg'
const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

describe('parseSessionLink', () => {
  it('accepts bare ids, keeping case, and canonical URIs', () => {
    expect(parseSessionLink(ID)).toBe(ID)
    expect(parseSessionLink(ID.toUpperCase())).toBe(ID.toUpperCase())
    expect(parseSessionLink(URI)).toBe(ID)
  })

  it('aligns with the host encoder', () => {
    for (const id of [ID, 'session-' + 'a'.repeat(32), 'sessión-中文']) {
      expect(parseSessionLink(encodeSessionReferenceUri(id as never))).toBe(id)
    }
  })

  it.each([
    ['', ''],
    ['padded', `${URI}==`],
    ['non base64url', 'dsh-session:abc+/.'],
    ['number payload', `dsh-session:${b64('123')}`],
    ['object payload', `dsh-session:${b64('{"a":1}')}`],
    ['bad utf8', `dsh-session:${Buffer.from([0x22, 0xff, 0x22]).toString('base64url')}`],
    ['empty payload', 'dsh-session:'],
    ['file name', 'session-notes.md'],
    ['path', 'docs/a.md'],
    ['short', 'session-abc'],
    ['dashless hex', 'session-0c880d5a52ec45f4b0f55578d70e540a'],
    ['suffix', `${ID}.md`],
    ['prefix', `./${ID}`],
  ])('rejects %s', (_name, input) => {
    expect(parseSessionLink(input)).toBeUndefined()
  })
})

describe('Markdown session links', () => {
  it.each([ID, URI])('opens %s through the session callback', (target) => {
    const openSession = vi.fn()
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openSession={openSession} openFile={openFile}>
        <MarkdownText text={`[label](${target})`} />
      </MarkdownDelegateProvider>,
    )
    const button = view.getByRole('button', { name: 'label' })
    expect(button.getAttribute('title')).toBe(ID)
    expect(button.className).toMatch(/fileMention/u)
    expect(button.className).toMatch(/sessionLink/u)
    expect(button.className).not.toMatch(/fileLink/u)
    expect(button.querySelector('svg')).not.toBeNull()
    expect(view.container.querySelector('a')).toBeNull()
    fireEvent.click(button)
    expect(openSession).toHaveBeenCalledExactlyOnceWith(ID)
    expect(openFile).not.toHaveBeenCalled()
  })

  it('uses a different icon than file links', () => {
    const view = render(
      <MarkdownDelegateProvider openSession={vi.fn()} openFile={vi.fn()}>
        <MarkdownText text={`[s](${ID}) [f](docs/a.md)`} />
      </MarkdownDelegateProvider>,
    )
    const icon = (name: string) => view.getByRole('button', { name }).querySelector('svg')!.outerHTML
    expect(icon('s')).not.toBe(icon('f'))
  })

  it.each([
    ['meta', { metaKey: true }], ['ctrl', { ctrlKey: true }], ['shift', { shiftKey: true }],
    ['alt', { altKey: true }], ['middle', { button: 1 }],
  ])('ignores %s clicks', (_name, init) => {
    const openSession = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openSession={openSession}>
        <MarkdownText text={`[label](${ID})`} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'label' }), init)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('renders text only while streaming', () => {
    const view = render(
      <MarkdownDelegateProvider openSession={vi.fn()} openFile={vi.fn()}>
        <MarkdownText text={`[label](${ID})`} streaming />
      </MarkdownDelegateProvider>,
    )
    expect(view.container.querySelector('button, a, svg')).toBeNull()
    expect(view.container.textContent).toContain('label')
  })

  it('renders text only without a session callback, never a file link', () => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={`[label](${ID})`} />
      </MarkdownDelegateProvider>,
    )
    expect(view.container.querySelector('button, a, svg')).toBeNull()
    expect(view.container.textContent).toContain('label')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('keeps file links and external links unchanged', () => {
    const openFile = vi.fn<(path: string) => void>()
    const openSession = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile} openSession={openSession}>
        <MarkdownText text={[
          '[a](session-notes.md)', `[b](./${ID}.md)`, `[c](docs/${ID}/a.md)`, '[d](docs/a.md)',
          '[e](https://a.com/)', '[f](mailto:a@b.c)', '[g](javascript:alert(1))',
        ].join(' ')} />
      </MarkdownDelegateProvider>,
    )
    for (const name of ['a', 'b', 'c', 'd']) {
      const button = view.getByRole('button', { name })
      expect(button.className).not.toMatch(/sessionLink/u)
      fireEvent.click(button)
    }
    expect(openFile.mock.calls.map(call => call[0])).toEqual(['session-notes.md', `./${ID}.md`, `docs/${ID}/a.md`, 'docs/a.md'])
    expect(openSession).not.toHaveBeenCalled()
    expect(view.getByRole('link', { name: 'e' }).getAttribute('href')).toBe('https://a.com/')
    expect(view.getByRole('link', { name: 'f' }).getAttribute('href')).toBe('mailto:a@b.c')
    expect(view.container.querySelectorAll('a')).toHaveLength(2)
    expect(view.container.textContent).toContain('g')
  })

  it('opens a session link whose target has surrounding spaces', () => {
    const openSession = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openSession={openSession}>
        <MarkdownText text={`[t]( ${ID} )`} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 't' }))
    expect(openSession).toHaveBeenCalledWith(ID)
  })

  it('does not treat an upper-case DSH-SESSION: scheme as a session link', () => {
    const openSession = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openSession={openSession}>
        <MarkdownText text="[t](DSH-SESSION:InNlc3Npb24tMGM4ODBkNWEtNTJlYy00NWY0LWIwZjUtNTU3OGQ3MGU1NDBhIg)" />
      </MarkdownDelegateProvider>,
    )
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.textContent).toContain('t')
    expect(openSession).not.toHaveBeenCalled()
  })
})
