/** Sidebar Recent section: sessions opened from the list appear newest first and survive a reload. */
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
const TITLES = ['Recent alpha', 'Recent bravo', 'Recent charlie'] as const

describe('web e2e: sidebar Recent section', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const ids: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const fixture = await readFile(SEED, 'utf8')
    const now = Date.now()
    for (const [index, title] of TITLES.entries()) {
      const id = await seedSession(scaffold, fixture, `sidebar-recent-${String(index)}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await scaffold.ctx.sessionController.rename({ sessionId: id, title })
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

  it('lists the two sessions opened from the sidebar newest first, and keeps them after a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-recent-visits'))
    const recent = page.locator('[data-section="recent"]')
    const recentTitles = () => recent.locator('[data-row-key^="recent-session:"] [class*="title"]').allTextContents()
    await expect.poll(recentTitles).toEqual([TITLES[0]])
    await page.locator(`[data-row-key="session:${ids[2]!}"]`).click()
    await page.locator(`[data-row-key="session:${ids[1]!}"]`).click()
    await expect.poll(recentTitles).toEqual([TITLES[1], TITLES[2], TITLES[0]])
    await expect(recent.getByRole('button', { name: /^Recent, 3 sessions$/u }).getAttribute('aria-expanded')).resolves.toBe('true')
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(recentTitles).toEqual([TITLES[1], TITLES[2], TITLES[0]])
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await recent.getByRole('button', { name: /^Recent, 3 sessions$/u }).click()
    await expect.poll(recentTitles).toEqual([])
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => recent.getByRole('button', { name: /^Recent, 3 sessions$/u }).getAttribute('aria-expanded')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  })
})
