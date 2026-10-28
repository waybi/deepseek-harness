/**
 * Session link destinations in Markdown: a bare `session-<uuid>` identifier or
 * the canonical `dsh-session:<base64url(JSON string)>` reference URI.
 */

const BARE_SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SESSION_URI_PREFIX = 'dsh-session:'
const BASE64URL = /^[A-Za-z0-9_-]+$/u

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeSessionUri(destination: string): string | undefined {
  const payload = destination.slice(SESSION_URI_PREFIX.length)
  if (!BASE64URL.test(payload)) return undefined
  try {
    const padded = payload.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'string') return undefined
    // Canonical form only: re-encoding must reproduce the authored payload.
    return toBase64Url(new TextEncoder().encode(JSON.stringify(value))) === payload ? value : undefined
  } catch {
    // Invalid base64, UTF-8, or JSON all mean this is not a session reference.
    return undefined
  }
}

/**
 * Recognize a Markdown link destination that names a session.
 * @param destination - Raw link destination as authored.
 * @returns The session identifier for a bare `session-<uuid>` (case preserved) or a canonical
 * `dsh-session:` URI; `undefined` for anything else, including malformed URIs and dashless 32-hex identifiers.
 */
export function parseSessionLink(destination: string): string | undefined {
  if (BARE_SESSION_ID.test(destination)) return destination
  if (destination.startsWith(SESSION_URI_PREFIX)) return decodeSessionUri(destination)
  return undefined
}
