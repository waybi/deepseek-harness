/** Keyless smoke: a chat Markdown link naming a workspace directory opens the Files page expanded to it; a file link keeps the preview. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SEED_ID = 'directory-link-web-e2e'
const DONE = 'DIRECTORY_LINK_DONE'

/** One settled turn whose answer links a nested directory and a file. */
function fixture(): string {
  const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]
  const session = Session.create(SessionId('directory-link-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: text('Where are the exam notes?'),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Directory link', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: text(`See [the exam folder](a/b/c) and [the notes](notes.md).\n\n${DONE}`),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe('web e2e: chat directory links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const cwd = scaffold.workspaceCwd
    await mkdir(join(cwd, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(cwd, 'a', 'b', 'c', 'exam.md'), '# Exam\n')
    await writeFile(join(cwd, 'notes.md'), '# Notes\n\nNOTES_BODY\n')
    await seedSession(scaffold, fixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('opens a directory link in the Files page and a file link in the preview', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-directory-link'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    const markdown = page.locator('[class*="markdown"]')
    const column = page.locator('[data-rightbar-col]')
    const root = scaffold.workspaceCwd
    const row = (path: string) => column.locator(`li[data-files-entry="directory"][data-files-path="${join(root, path)}"]`)

    await markdown.getByRole('button', { name: 'the exam folder' }).click()
    await expect.poll(() => row('a').locator(':scope > button').getAttribute('aria-expanded'), { timeout: 15_000 }).toBe('true')
    await expect.poll(() => row('a/b').locator(':scope > button').getAttribute('aria-expanded'), { timeout: 15_000 }).toBe('true')
    await expect.poll(() => row('a/b/c').isVisible(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => row('a/b/c').evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const body = node.closest('[data-rightbar-col]')!.getBoundingClientRect()
      return rect.top >= body.top && rect.bottom <= body.bottom
    })).toBe(true)
    expect(await column.locator('[data-textpreview-url]').count()).toBe(0)
    expect(await page.getByText('is a directory').count()).toBe(0)

    await markdown.getByRole('button', { name: 'the notes' }).click()
    const preview = column.locator('[data-textpreview-url]')
    await expect.poll(async () => (await preview.getAttribute('data-textpreview-url'))?.endsWith('/notes.md'), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => column.getByText('NOTES_BODY').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await page.getByText('is a directory').count()).toBe(0)
  }, 90_000)
})
