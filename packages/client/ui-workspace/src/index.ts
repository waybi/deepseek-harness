/**
 * Workspace picker plugin, node half. It embeds the validated sidebar options
 * in browser pages; the browser half ships via exports["./client"],
 * discovered through the package.json dsh.client declaration.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { compileHiddenSessionIdPatterns, type Config, WORKSPACE_BROWSER_CONFIG_GLOBAL } from './config.ts'

export { Config } from './config.ts'

/**
 * Publish the Workspace browser options before browser plugins activate.
 * @param ctx - Host context serving browser pages.
 * @param config - plugin options with schema defaults applied by the Loader.
 * @throws Error when a `hiddenSessionIdPatterns` entry is not a valid regular expression, failing the plugin load.
 */
export function apply(ctx: Context, config: Config): void {
  compileHiddenSessionIdPatterns(config.hiddenSessionIdPatterns)
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: WORKSPACE_BROWSER_CONFIG_GLOBAL,
      value: {
        hiddenSessionCwdPrefixes: config.hiddenSessionCwdPrefixes,
        hiddenSessionIdPatterns: config.hiddenSessionIdPatterns,
      },
    })
  })
}
