// Web e2e scenario: Sessions whose projection-cache records lie outside the
// cache's startup set and resident bound. The shipped Web composition runs with
// an overlay capping complete resident records at 5; 41 cold Sessions with
// stored cache records must still list their titles, stay reachable by
// scrolling and by title search, open with the logged content, and an
// interrupted one must accept a continued prompt answered by the replay script.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const DAY = 86_400_000
const COLD_COUNT = 40
const REPLY = 'LAZY_RESUME_REPLY_DONE'
const titleOf = (index: number): string => `Lazy cold title ${String(index).padStart(2, '0')}`
const messageOf = (index: number): string => `LAZY_COLD_MESSAGE_${String(index).padStart(2, '0')}`
const INTERRUPTED_TITLE = 'Lazy interrupted title'
const INTERRUPTED_MESSAGE = 'LAZY_INTERRUPTED_MESSAGE'

function replyStream(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: REPLY },
    { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
    { type: 'usage', usage: { inputTokens: 64, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('web e2e: Sessions outside the projection-cache resident set', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let scratch: string
  let tripwire: ReturnType<typeof watchConsole>

  /** Persist one cold Session log and its stored cache record, last changed `ageDays` ago. */
  async function seedCold(id: string, createdAt: number, title: string, text: string, ended: boolean, ageDays: number): Promise<void> {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt,
      cwd: scaffold.workspaceCwd, isSeeded: false, delegationDepth: 0,
    }
    const events = [
      { type: 'session/title', seq: SessionSeq(0), time: createdAt, data: { title, messageSeqs: [], source: { kind: 'user' } } },
      { type: 'turn/start', seq: SessionSeq(1), time: createdAt + 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: SessionSeq(2), time: createdAt + 2, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      },
      ...ended ? [{ type: 'turn/end', seq: SessionSeq(3), time: createdAt + 3, data: { turn: 1, reason: { kind: 'completed' } } }] : [],
    ] as SessionEvent[]
    const handle = await scaffold.ctx.sessionPersistence.create(header)
    try {
      await handle.append(events)
    } finally {
      await handle.close()
    }
    const path = join(scaffold.harnessHome, 'storages', projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: projectionCacheDomainSpec.version,
      record: {
        identity: { formatVersion: SESSION_FORMAT_VERSION, createdAt, cwd: scaffold.workspaceCwd, isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 0, val: title },
          sessionListMetadata: { ver: 1, seq: events.length - 1, val: { blank: false, lastPromptAt: createdAt + 2 } },
        },
      },
    }))
    const when = new Date(Date.now() - ageDays * DAY)
    await utimes(path, when, when)
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-lazy-projection-e2e-'))
    const replayOverride = join(scratch, 'replay.override.json')
    const script: ReplayOverrideDoc = [{ kind: 'chunks', chunks: replyStream() }]
    await writeFile(replayOverride, JSON.stringify(script))
    const overlay = join(scratch, 'resident-bound.overlay.yml')
    await writeFile(overlay, [
      '- id: session-projection-cache',
      '  config:',
      '    writeEveryEvents: 200',
      '    writeIntervalMs: 5000',
      '    startupMaxAgeDays: 30',
      '    maxResidentRecords: 5',
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({
      replayFixture: join(scratch, 'override-only.jsonl'),
      replayOverride,
      extraOverlayPath: overlay,
    })
    const now = Date.now()
    for (let index = 0; index < COLD_COUNT; index++) {
      await seedCold(`lazy-cold-${String(index).padStart(2, '0')}`, now - (40 + index) * DAY, titleOf(index), messageOf(index), true, 40 + index)
    }
    await seedCold('lazy-interrupted', now - 120 * DAY, INTERRUPTED_TITLE, INTERRUPTED_MESSAGE, false, 120)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('lists, scrolls to, searches, opens, and resumes cold Sessions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lazy-session-projection'))
    const domain = scaffold.ctx.storageDomain.get(projectionCacheDomainSpec.name)
    if (domain === undefined) throw new Error('projection cache domain is not open')
    const residents = (): number => domain.table('sessions').size

    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    // Every cold row gets its stored title; the oldest is reachable by expanding and scrolling.
    await page.getByRole('treeitem', { name: new RegExp(titleOf(0)) }).waitFor({ timeout: 30_000 })
    const more = page.getByText(/^Show \d+ more sessions$/u)
    while (await more.count() > 0) await more.first().click()
    const oldest = page.getByRole('treeitem', { name: new RegExp(INTERRUPTED_TITLE) })
    await oldest.waitFor({ timeout: 30_000 })
    await oldest.scrollIntoViewIfNeeded()
    for (const index of [0, 17, COLD_COUNT - 1]) {
      await page.getByRole('treeitem', { name: new RegExp(titleOf(index)) }).waitFor({ timeout: 15_000 })
    }
    expect(residents()).toBeLessThanOrEqual(5)
    await page.screenshot({ path: join(scratch, 'list.png') })

    // Title search finds a cold Session by its stored title.
    await page.getByRole('button', { name: 'Search sessions' }).first().click()
    await page.getByPlaceholder('Search session names').fill(titleOf(33))
    const hit = page.getByRole('treeitem', { name: new RegExp(titleOf(33)) })
    await hit.waitFor({ timeout: 15_000 })
    await hit.click()
    await page.getByText(messageOf(33), { exact: true }).first().waitFor({ timeout: 20_000 })

    // The interrupted Session outside the window opens with its logged prompt and continues.
    await page.getByPlaceholder('Search session names').fill(INTERRUPTED_TITLE)
    await page.getByRole('treeitem', { name: new RegExp(INTERRUPTED_TITLE) }).click()
    await page.getByText(INTERRUPTED_MESSAGE, { exact: true }).first().waitFor({ timeout: 20_000 })
    const composer = page.locator('[data-composer-input]')
    await writeComposerDraft(page, composer, 'Continue after the cold resume')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText(REPLY).first().waitFor({ timeout: 30_000 })
    expect(scaffold.ctx.agents.get(SessionId('lazy-interrupted'))?.session.header.createdAt).toBeLessThan(Date.now() - 100 * DAY)
    await page.screenshot({ path: process.env.DSH_LAZY_E2E_SHOT ?? join(scratch, 'resumed.png') })
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
