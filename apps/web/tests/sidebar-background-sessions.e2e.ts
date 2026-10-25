/** Background-directory Session hiding through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./sidebar-background-sessions.overlay.yml', import.meta.url))
const OWN = 'Own conversation'
const BACKGROUND = 'Crafter conversation'
const NEIGHBOR = 'Neighbor conversation'

describe('web e2e: sidebar background Sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    const fixture = await readFile(SEED, 'utf8')
    const now = Date.now()
    const seeds = [
      { title: OWN, cwd: undefined },
      { title: BACKGROUND, cwd: '/dsh-e2e-background/board/card' },
      { title: NEIGHBOR, cwd: '/dsh-e2e-background-x/card' },
    ]
    const ids: string[] = []
    for (const [index, seed] of seeds.entries()) {
      const id = await seedSession(scaffold, fixture, `sidebar-background-${index}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
        ...seed.cwd === undefined ? {} : { cwd: seed.cwd },
      })
      await scaffold.ctx.sessionController.rename({ sessionId: id, title: seed.title })
      ids.push(id)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.addInitScript((current) => {
      if (localStorage.getItem('dsh.workspace.view.v5') !== null) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: current }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'flat', orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {},
      }))
    }, ids[0])
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('hides background rows by default, shows them from View options, and keeps the choice on reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-background-sessions'))
    const titles = () => page.locator('[role="treeitem"]:not([aria-expanded]) [class*="title"]').allTextContents()
    const toggle = async (): Promise<void> => {
      await page.getByRole('button', { name: 'View options' }).click()
      await page.getByRole('menuitem', { name: 'Show background sessions', exact: true }).click()
    }
    await expect.poll(titles).toEqual([OWN, NEIGHBOR])
    await toggle()
    await expect.poll(titles).toEqual([OWN, BACKGROUND, NEIGHBOR])
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual([OWN, BACKGROUND, NEIGHBOR])
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await toggle()
    await expect.poll(titles).toEqual([OWN, NEIGHBOR])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
