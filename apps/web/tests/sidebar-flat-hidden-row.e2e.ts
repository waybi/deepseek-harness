/** Single-list rows placed by rendered height: a row hidden by an injected style leaves no gap. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const COUNT = 6
const PITCH = 34
const TOLERANCE = 1

declare global {
  interface Window {
    __dshFirstFlatGeometry?: Geometry
  }
}

interface Geometry {
  readonly tops: Readonly<Record<string, number>>
  readonly visible: readonly string[]
  readonly spacer: number
}

/** Read every row's top relative to the spacer, in list order, plus the spacer height. */
function readGeometry(): Geometry | undefined {
  const rows = [...document.querySelectorAll<HTMLElement>('[role="tree"][aria-label="Sessions"] [data-row-key^="session:"]')]
  const spacer = rows[0]?.closest<HTMLElement>('[style*="height"]')
  if (spacer === undefined || spacer === null) return undefined
  const origin = spacer.getBoundingClientRect().top
  const tops: Record<string, number> = {}
  const visible: string[] = []
  for (const row of rows) {
    const id = (row.dataset.rowKey ?? '').slice('session:'.length)
    const box = row.getBoundingClientRect()
    tops[id] = box.top - origin
    if (box.height > 0) visible.push(id)
  }
  return { tops, visible, spacer: spacer.getBoundingClientRect().height }
}

async function geometry(page: Page): Promise<Geometry> {
  const current = await page.evaluate(`(${readGeometry.toString()})()`) as Geometry | undefined
  if (current === undefined) throw new Error('flat spacer is unavailable')
  return current
}

/** Resolve after two animation frames so observed size changes have been placed. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
}

function expectPitch(current: Geometry): void {
  for (let index = 1; index < current.visible.length; index += 1) {
    const step = (current.tops[current.visible[index] as string] as number)
      - (current.tops[current.visible[index - 1] as string] as number)
    expect(Math.abs(step - PITCH)).toBeLessThanOrEqual(TOLERANCE)
  }
}

describe('web e2e: sidebar flat list hidden rows', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const fixture = await readFile(SEED, 'utf8')
    const now = Date.now()
    for (let index = 0; index < COUNT; index += 1) {
      const id = await seedSession(scaffold, fixture, `flat-hidden-${String(index)}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await scaffold.ctx.sessionController.rename({ sessionId: id, title: `Flat row ${String(index)}` })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    // Record the rows in the first frame they all appear, before any
    // ResizeObserver measurement is placed.
    await page.addInitScript(`(() => {
      const read = ${readGeometry.toString()}
      const record = () => {
        if (window.__dshFirstFlatGeometry !== undefined) return
        const current = read()
        if (current !== undefined && current.visible.length >= ${String(COUNT)}) window.__dshFirstFlatGeometry = current
        else requestAnimationFrame(record)
      }
      requestAnimationFrame(record)
    })()`)
    await page.addInitScript(() => {
      if (localStorage.getItem('dsh.workspace.view.v5') !== null) return
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'flat', orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {},
      }))
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('closes the gap of a row hidden by an injected style and restores it when the style is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-flat-hidden-row'))
    await expect.poll(async () => (await geometry(page)).visible.length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(COUNT)
    // The first frame after the rows appear and the settled frames agree:
    // measuring an unhidden list moves no row.
    const first = await page.evaluate(() => window.__dshFirstFlatGeometry)
    if (first === undefined) throw new Error('the first flat frame was not recorded')
    await settle(page)
    await page.waitForTimeout(200)
    const before = await geometry(page)
    for (const id of before.visible) {
      expect(Math.abs((before.tops[id] as number) - (first.tops[id] as number))).toBeLessThanOrEqual(TOLERANCE)
    }
    expect(Math.abs(before.spacer - first.spacer)).toBeLessThanOrEqual(TOLERANCE)
    expectPitch(before)

    const hidden = before.visible[2] as string
    const next = before.visible[3] as string
    await page.addStyleTag({ content: `[data-row-key="session:${hidden}"]{display:none}` })
    await expect.poll(async () => {
      const current = await geometry(page)
      return Math.abs((current.tops[next] as number) - (before.tops[hidden] as number))
    }).toBeLessThanOrEqual(TOLERANCE)
    const after = await geometry(page)
    expect(after.visible).not.toContain(hidden)
    expect(after.visible).toHaveLength(before.visible.length - 1)
    expectPitch(after)
    expect(Math.abs(before.spacer - after.spacer - PITCH)).toBeLessThanOrEqual(TOLERANCE)

    await page.evaluate((id) => {
      for (const style of document.querySelectorAll('style')) {
        if ((style.textContent ?? '').includes(`session:${id}`)) style.remove()
      }
    }, hidden)
    await expect.poll(async () => (await geometry(page)).visible.length).toBe(before.visible.length)
    await settle(page)
    const restored = await geometry(page)
    for (const id of before.visible) {
      expect(Math.abs((restored.tops[id] as number) - (before.tops[id] as number))).toBeLessThanOrEqual(TOLERANCE)
    }
    expect(Math.abs(restored.spacer - before.spacer)).toBeLessThanOrEqual(TOLERANCE)
    expect(tripwire.pageErrors).toEqual([])
  })
})
