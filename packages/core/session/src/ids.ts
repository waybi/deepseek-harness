/** Branded Session identity and log-position types with their constructors. */

import { brandNumber, brandString, type Branded, type BrandedNumber } from '@deepseek-ai/dsh-brand'

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string with the session-id brand.
 */
export function SessionId(id: string): SessionId {
  return brandString<SessionId>(id)
}

/** Sequence number of one existing event in a Session log. */
export type SessionSeq = BrandedNumber<'SessionSeq'>

/**
 * Admit a numeric value as an existing Session event position.
 * @param value - non-negative safe integer admitted by the owning log operation.
 * @returns the same number with the Session-sequence brand.
 */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionSeq>(value)
}

/** A Session log gap, prefix length, or read offset, which may equal the event count. */
export type SessionLogOffset = BrandedNumber<'SessionLogOffset'>

/**
 * Admit a numeric value as a Session log offset.
 * @param value - non-negative safe integer used as a gap or prefix length.
 * @returns the same number with the Session-log-offset brand.
 */
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionLogOffset>(value)
}
