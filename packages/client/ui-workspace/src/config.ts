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
}

/** Validated deployment options embedded in browser pages. */
export const Config: z<Partial<Config>, Config> = z.object({
  hiddenSessionCwdPrefixes: z.array(z.string()).default(['~/.routa/workspace']),
})

/** Page-global key carrying the validated Workspace browser options. */
export const WORKSPACE_BROWSER_CONFIG_GLOBAL = '__DSH_WORKSPACE_BROWSER_CONFIG__'
