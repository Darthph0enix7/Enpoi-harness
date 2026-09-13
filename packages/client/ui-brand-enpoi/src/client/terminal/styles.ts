/**
 * enpoi: the xterm.js stylesheet the terminal surfaces need, compiled inline
 * and installed for exactly the plugin's lifetime (the same lifecycle pattern
 * `ui-theme` uses for the app's global sheets).
 */
import type { Context } from '@deepseek-ai/cordis'
import xterm from '@xterm/xterm/css/xterm.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-brand-enpoi'

/**
 * Install the terminal stylesheet while the plugin is mounted.
 * @param ctx - owning plugin context.
 */
export function installTerminalStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/xterm.css`
    tag.textContent = xterm
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'enpoi: xterm stylesheet')
}
