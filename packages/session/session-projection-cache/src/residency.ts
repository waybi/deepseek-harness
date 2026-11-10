/**
 * Residency policy of the projection cache: which stored checkpoint records
 * start in memory, and in which order clean records leave memory again. The
 * storage domain only lists and reads records; choosing them is this
 * package's policy.
 * @module @deepseek-ai/dsh-session-projection-cache/src/residency
 */

import type { KvRecordStamp } from '@deepseek-ai/dsh-storage-domain'

const DAY_MS = 86_400_000

/**
 * Choose the records a fresh cache loads at startup: records modified at or
 * after `nowMs - maxAgeDays` days, newest first (equal times ordered by key),
 * at most `maxRecords` of them.
 * @param stamps - every stored record key with its last-modified time.
 * @param nowMs - current time in epoch milliseconds.
 * @param maxAgeDays - startup window in days; the window start is inclusive.
 * @param maxRecords - most records loaded.
 * @returns the selected keys, newest first.
 */
export function selectStartupKeys(
  stamps: readonly KvRecordStamp[],
  nowMs: number,
  maxAgeDays: number,
  maxRecords: number,
): string[] {
  const windowStart = nowMs - maxAgeDays * DAY_MS
  return stamps
    .filter(stamp => stamp.modifiedAt >= windowStart)
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt || compareKeys(left.key, right.key))
    .slice(0, maxRecords)
    .map(stamp => stamp.key)
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Least-recently-used order of resident record keys. The owner reports every
 * use and removal; {@link evictionCandidates} walks the order oldest first.
 */
export class RecencyOrder<K> {
  private readonly order = new Set<K>()

  /**
   * Mark one key as the most recently used.
   * @param key - resident record key.
   */
  touch(key: K): void {
    this.order.delete(key)
    this.order.add(key)
  }

  /**
   * Remove one key from the order.
   * @param key - record key that left memory.
   */
  forget(key: K): void {
    this.order.delete(key)
  }

  /**
   * Keys in least-recently-used order, snapshotted so the caller may forget
   * keys while iterating.
   * @returns the keys, oldest use first.
   */
  evictionCandidates(): K[] {
    return [...this.order]
  }
}
