import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import {
  SUMMARY_CODE_POINTS,
  toolResultSurfaceProjection,
} from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import type { ToolResultSurfaceState } from '@deepseek-ai/dsh-compaction-tool-result-expiry'
import { decompressZstdFrame, scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { scanLog } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'

const SOURCE = process.env['DSH_REAL_SESSION_DIR'] ?? join(process.env['HOME'] ?? '', '.dsh', 'sessions')
const SAMPLE = Number(process.env['DSH_REAL_SESSION_SAMPLE'] ?? 20)

/** Recursively collect session log files, newest first. */
function findLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(path)
    }
  }
  walk(root)
  // Older than ten minutes: an actively written log is not a stable fixture.
  const cutoff = Date.now() - 10 * 60_000
  return found
    .filter(path => statSync(path).mtimeMs < cutoff)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
}

/** Decode every complete Zstandard frame of one stored log. */
async function readLog(path: string): Promise<ReturnType<typeof scanLog>> {
  const bytes = readFileSync(path)
  const { frames } = scanZstdFrames(bytes)
  const parts: Buffer[] = []
  for (const frame of frames) parts.push(await decompressZstdFrame(bytes.subarray(frame.start, frame.end)))
  return scanLog(Buffer.concat(parts))
}

/** Independent text digest used as the judge for one message's text blocks. */
function independentText(blocks: readonly { type: string; text?: unknown }[]): string {
  const texts = blocks.filter(block => block.type === 'text').map(block => String(block.text))
  return JSON.stringify(texts)
}

interface SessionReport {
  id: string
  nodes: number
  checked: number
  mismatches: string[]
  imageOffloadOnly: number
}

describe.skipIf(!existsSync(SOURCE))('real session logs rebuilt in isolation', () => {
  it(`compares at least ${SAMPLE} real sessions without touching the originals`, async () => {
    const logs = findLogs(SOURCE)
    const isolated = mkdtempSync(join(tmpdir(), 'dsh-toolresult-real-'))
    const reports: SessionReport[] = []
    let sampled = 0
    let unreadable = 0
    const originals = new Map<string, { mtimeMs: number; size: number }>()

    for (const path of logs) {
      if (sampled >= SAMPLE) break
      const size = statSync(path).size
      if (size === 0) continue
      let stored: ReturnType<typeof scanLog>
      try {
        stored = await readLog(path)
      } catch {
        unreadable += 1
        continue
      }
      const hasToolResult = stored.events.some(event => event.type === 'tool/result')
      if (!hasToolResult) continue

      // Copy first: the original is only ever read, and the read happens on the copy.
      const destination = join(isolated, `${sampled}-${basename(dirname(path))}`, 'session.v4.jsonl.zstd')
      mkdirSync(dirname(destination), { recursive: true })
      originals.set(path, { mtimeMs: statSync(path).mtimeMs, size })
      copyFileSync(path, destination)
      const copy = await readLog(destination)
      sampled += 1

      const session = Session.create(
        SessionId(copy.meta.id),
        copy.events,
        copy.meta as SessionHeader,
        copy.inheritedEventCount,
        [imageOffloadProjection],
      )
      let state = toolResultSurfaceProjection.init()
      for (const event of copy.events) state = toolResultSurfaceProjection.apply(state, event)
      const surface = state as ToolResultSurfaceState
      const derived = new Map(session.deriveMessages().map(message => [message.id, message]))

      const report: SessionReport = { id: copy.meta.id, nodes: surface.nodes.length, checked: 0, mismatches: [], imageOffloadOnly: 0 }
      for (const node of surface.nodes) {
        const message = derived.get(node.messageId)
        const source = copy.events[node.seq]
        if (message === undefined || source?.type !== 'tool/result') {
          report.mismatches.push(`node ${node.seq}: derived message or source event missing`)
          continue
        }
        const derivedText = independentText(message.content)
        const storedText = independentText(source.data.message.content)
        if (derivedText !== storedText) {
          report.mismatches.push(`node ${node.seq}: derived text differs from the logged tool/result`)
          continue
        }
        const texts = JSON.parse(derivedText) as string[]
        const expectedHash = createHash('sha256').update(JSON.stringify(texts), 'utf8').digest('hex').slice(0, 16)
        const expectedChars = texts.reduce((total, text) => total + [...text].length, 0)
        if (node.textHash !== expectedHash) report.mismatches.push(`node ${node.seq}: hash mismatch`)
        if (node.textChars !== expectedChars) report.mismatches.push(`node ${node.seq}: chars ${node.textChars} != ${expectedChars}`)
        if (node.summary !== [...texts.join('')].slice(0, SUMMARY_CODE_POINTS).join('')) {
          report.mismatches.push(`node ${node.seq}: summary mismatch`)
        }
        report.checked += 1
      }
      const offloaded = copy.events.filter(event => event.type === 'image/offload').length
      report.imageOffloadOnly = offloaded
      reports.push(report)
    }

    const checked = reports.reduce((total, report) => total + report.checked, 0)
    const mismatches = reports.flatMap(report => report.mismatches)
    const summary = {
      source: SOURCE,
      isolated,
      sessions: reports.length,
      nodes: reports.reduce((total, report) => total + report.nodes, 0),
      checked,
      mismatchedSessions: reports.filter(report => report.mismatches.length > 0).length,
      mismatches,
      unreadable,
      imageOffloadEvents: reports.reduce((total, report) => total + report.imageOffloadOnly, 0),
    }
    console.log(`REAL_SESSION_REPORT ${JSON.stringify(summary)}`)

    // Originals keep their bytes and modification time: this test never wrote them.
    for (const [path, before] of originals) {
      const after = statSync(path)
      expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual(before)
    }
    expect(reports.length).toBeGreaterThanOrEqual(SAMPLE)
    expect(mismatches).toEqual([])
    expect(reports.every(report => report.nodes === report.checked)).toBe(true)
    // Keep the isolated copy path visible in the run log for the evidence table.
    expect(summary.isolated).toContain('dsh-toolresult-real-')
  }, 120_000)
})
