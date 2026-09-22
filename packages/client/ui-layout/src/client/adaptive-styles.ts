import type { Context as ClientContext } from '@deepseek-ai/cordis'
import adaptive from './adaptive.css?inline'

/** Plugin id stamped on the injected style tag. */
const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-layout'

/**
 * Mount the mobile foundation stylesheet for exactly the owning plugin
 * lifetime, the same lifecycle the theme sheets use.
 * @param ctx - owning client context.
 */
export function installAdaptiveStyles(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/adaptive.css`
    tag.textContent = adaptive
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'ui-layout: adaptive foundation stylesheet')
}
