/**
 * Relative-time reference for Session rows. Labels are recomputed only when
 * their list renders; the reference changes once per wall-clock minute, so a
 * render triggered by unrelated data hands memoized rows the same `now` and
 * they skip re-rendering. Row labels use minute or coarser units; the value
 * lags the wall clock by less than one minute.
 */

const MINUTE_MS = 60_000

/**
 * Read the current time rounded down to the minute.
 * @returns epoch milliseconds at the start of the current minute.
 */
export function minuteNow(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS
}
