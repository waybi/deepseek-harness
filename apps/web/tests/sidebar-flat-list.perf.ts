// Opt-in browser benchmark for the sidebar's "In one list" view with 1,000
// Sessions. It reports Chromium work per interaction without timing
// assertions because host speed is not a correctness contract; structural
// assertions keep the seeded Session count from silently shrinking.
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SESSION_COUNT = 1_000
const RUNS = 3
const SCROLL_STEP_PX = 400

interface ScenarioSample {
  readonly wallMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly recalcStyleCount: number
  readonly longTasks: number
  readonly mountedRows: number
}

declare global {
  interface Window {
    __dshLongTasks?: number
  }
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function compactFixture(): string {
  const session = Session.create(SessionId('flat-perf-template'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Inspect this compact synthetic session.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Flat list session', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Done.' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 100, outputTokens: 10 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: Date.now() - 60_000,
    cwd: '{{cwd}}',
    isSeeded: false,
    delegationDepth: 0,
  }
  return [JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const payload = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(payload.metrics.map(metric => [metric.name, metric.value]))
}

function metric(values: Record<string, number>, name: string): number {
  const value = values[name]
  if (value === undefined) throw new Error(`Chromium performance metric ${name} is unavailable`)
  return value
}

async function mountedRows(page: Page): Promise<number> {
  return page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"]').count()
}

async function listGeometry(page: Page): Promise<{ scroll: number; row: number }> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    const row = list?.querySelector<HTMLElement>('[role="treeitem"]')
    return { scroll: list?.scrollHeight ?? 0, row: row?.getBoundingClientRect().height ?? 0 }
  })
}

async function measure(page: Page, cdp: CDPSession, action: () => Promise<void>): Promise<ScenarioSample> {
  const longTasksBefore = await page.evaluate(() => window.__dshLongTasks ?? 0)
  const before = await metrics(cdp)
  const started = performance.now()
  await action()
  // Two frames let deferred layout and long tasks from the last commit land.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  const wallMs = performance.now() - started
  const after = await metrics(cdp)
  const longTasksAfter = await page.evaluate(() => window.__dshLongTasks ?? 0)
  return {
    wallMs: rounded(wallMs),
    scriptMs: rounded((metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration')) * 1_000),
    layoutMs: rounded((metric(after, 'LayoutDuration') - metric(before, 'LayoutDuration')) * 1_000),
    recalcStyleCount: metric(after, 'RecalcStyleCount') - metric(before, 'RecalcStyleCount'),
    longTasks: longTasksAfter - longTasksBefore,
    mountedRows: await mountedRows(page),
  }
}

async function stableRowCount(page: Page): Promise<number> {
  const deadline = performance.now() + 60_000
  let previous = -1
  let stable = 0
  while (performance.now() < deadline) {
    const count = await mountedRows(page)
    stable = count > 0 && count === previous ? stable + 1 : 0
    if (stable >= 4) return count
    previous = count
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`flat row count did not stabilize; last count ${String(previous)}`)
}

async function pickGroupBy(page: Page, name: 'In one list' | 'WorkSpace'): Promise<void> {
  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function scrollList(page: Page, toBottom: boolean): Promise<void> {
  await page.evaluate(async ({ step, bottom }) => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    if (list === null) throw new Error('flat list is unavailable')
    const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => { resolve() }) })
    if (!bottom) {
      list.scrollTop = 0
      await frame()
      return
    }
    while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
      list.scrollTop += step
      await frame()
    }
  }, { step: SCROLL_STEP_PX, bottom: toBottom })
}

function summarize(samples: readonly ScenarioSample[]): Record<string, string | number> {
  const range = (key: keyof ScenarioSample): string => {
    const values = samples.map(sample => sample[key])
    return `${String(Math.min(...values))}–${String(Math.max(...values))}`
  }
  return {
    runs: samples.length,
    scriptMs: range('scriptMs'),
    layoutMs: range('layoutMs'),
    recalcStyleCount: range('recalcStyleCount'),
    longTasks: range('longTasks'),
    wallMs: range('wallMs'),
    mountedRows: range('mountedRows'),
  }
}

describe('manual web performance: sidebar flat list', () => {
  let browser: Browser
  let scaffold: WebScaffold

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') {
      throw new Error('manual web performance runs only with deterministic replay')
    }
    scaffold = await launchWebScaffold()
    const fixture = compactFixture()
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      await seedSession(scaffold, fixture, `flat-perf-${String(index).padStart(4, '0')}`)
    }
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reports switch, scroll, status, and open costs for 1,000 flat rows', async () => {
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    try {
      await page.addInitScript(() => {
        window.__dshLongTasks = 0
        new PerformanceObserver((list) => {
          window.__dshLongTasks = (window.__dshLongTasks ?? 0) + list.getEntries().length
        }).observe({ type: 'longtask' })
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await page.getByRole('treeitem').first().waitFor({ timeout: 60_000 })
      // Warm-up switch: the flat list must address every seeded Session, so
      // its scroll height spans all rows even when only a window is mounted.
      await pickGroupBy(page, 'In one list')
      await expect.poll(() => listGeometry(page), { timeout: 60_000 })
        .toSatisfy(({ scroll, row }) => row > 0 && scroll >= row * SESSION_COUNT)
      await pickGroupBy(page, 'WorkSpace')
      await expect.poll(() => mountedRows(page)).toBeLessThan(10)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')

      const switchSamples: ScenarioSample[] = []
      for (let run = 0; run < RUNS; run += 1) {
        switchSamples.push(await measure(page, cdp, async () => {
          await pickGroupBy(page, 'In one list')
          await stableRowCount(page)
        }))
        if (run < RUNS - 1) {
          await pickGroupBy(page, 'WorkSpace')
          await expect.poll(() => mountedRows(page)).toBeLessThan(10)
        }
      }

      const scrollSamples: ScenarioSample[] = []
      for (let run = 0; run < RUNS; run += 1) {
        await scrollList(page, false)
        scrollSamples.push(await measure(page, cdp, () => scrollList(page, true)))
      }
      await scrollList(page, false)
      await page.waitForTimeout(200)

      const firstKey = await page.locator('[role="tree"][aria-label="Sessions"] [data-row-key^="session:"]').first()
        .getAttribute('data-row-key')
      const toggledId = SessionId((firstKey ?? '').slice('session:'.length))
      expect(toggledId.startsWith('flat-perf-')).toBe(true)
      const toggledRow = page.locator(`[data-row-key="session:${toggledId}"]`)
      const statusSamples: ScenarioSample[] = []
      for (let run = 0; run < RUNS; run += 1) {
        statusSamples.push(await measure(page, cdp, async () => {
          scaffold.ctx.emit('api-session/status', toggledId, true)
          await toggledRow.getByText('Running', { exact: true }).waitFor({ state: 'attached' })
        }))
        scaffold.ctx.emit('api-session/status', toggledId, false)
        await toggledRow.getByText('Running', { exact: true }).waitFor({ state: 'detached' })
      }

      const openSamples: ScenarioSample[] = []
      for (let run = 0; run < RUNS; run += 1) {
        const row = page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"]').nth(3 + run)
        openSamples.push(await measure(page, cdp, async () => {
          await row.click()
          await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
        }))
      }

      const seeded = (await scaffold.ctx.sessionPersistence.list())
        .filter(snapshot => snapshot.header.id.startsWith('flat-perf-'))
      expect(seeded).toHaveLength(SESSION_COUNT)
      console.info(`WEB_PERF_RESULT ${JSON.stringify({
        scenario: 'sidebar-flat-list',
        sessions: SESSION_COUNT,
        sessionFormat: SESSION_FORMAT_VERSION,
        switchToFlat: summarize(switchSamples),
        scrollToBottom: summarize(scrollSamples),
        singleStatusChange: summarize(statusSamples),
        openSession: summarize(openSamples),
        samples: { switchSamples, scrollSamples, statusSamples, openSamples },
      }, null, 2)}`)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })
})
