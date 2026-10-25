/** Sidebar options shared by the Host configuration and the browser Workspace browser. */
import z from '@deepseek-ai/schemastery'

/** Workspace browser options after schema defaults are applied. */
export interface Config {
  /**
   * Working-directory prefixes whose Sessions the sidebar hides until the
   * view option shows background Sessions. A leading `~` names the Host
   * account home; matching uses whole `/` path segments.
   */
  hiddenSessionCwdPrefixes: string[]
  /**
   * Regular-expression sources matched against the whole Session id; a
   * matching Session is hidden like one under {@link hiddenSessionCwdPrefixes}.
   * The default matches a bare lowercase UUID, the id form ACP-created
   * Sessions use.
   */
  hiddenSessionIdPatterns: string[]
}

/** Bare lowercase UUID: the id form of Sessions created through ACP `session/new`. */
export const BARE_UUID_SESSION_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

/** Validated deployment options embedded in browser pages. */
export const Config: z<Partial<Config>, Config> = z.object({
  hiddenSessionCwdPrefixes: z.array(z.string()).default(['~/.routa/workspace']),
  hiddenSessionIdPatterns: z.array(z.string()).default([BARE_UUID_SESSION_ID_PATTERN]),
})

/**
 * Compile configured Session-id patterns so each matches only a whole id.
 * @param patterns - regular-expression sources from {@link Config.hiddenSessionIdPatterns}.
 * @returns one anchored expression per source, in order.
 * @throws Error naming the option and the offending source when one is not a valid regular expression.
 */
export function compileHiddenSessionIdPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => {
    try {
      return new RegExp(`^(?:${source})$`)
    } catch (error) {
      throw new Error(`ui-workspace hiddenSessionIdPatterns: invalid regular expression ${JSON.stringify(source)}`, { cause: error })
    }
  })
}

/** Page-global key carrying the validated Workspace browser options. */
export const WORKSPACE_BROWSER_CONFIG_GLOBAL = '__DSH_WORKSPACE_BROWSER_CONFIG__'
