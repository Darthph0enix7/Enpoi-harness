/**
 * Test fixture: mount a function plugin behind the Loader and edit its raw
 * configuration through the same volatile-update path the deployed profile
 * uses — the seam `packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts`
 * exercises for llm-pi-ai. An edit that changes only `.volatile()` fields
 * commits into the running fiber and emits `loader/volatile-update`; the
 * plugin is not remounted.
 */
import { Context, resolveConfig, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before && typeof before === 'object' && !Array.isArray(before)
      && value && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as Record<string, unknown>, value as Record<string, unknown>) : value
  }
  return result
}

/**
 * Mount `plugin` behind the Loader with `initial` config.
 * @param ctx - owning context; the Loader is mounted when absent.
 * @param plugin - the function plugin to mount.
 * @param initial - initial raw configuration.
 * @returns `update` deep-merges a patch into the stored raw config, `replace`
 * swaps the whole raw config; both run the loader's config resolution and
 * commit before resolving.
 */
export async function liveConfig(ctx: Context, plugin: Plugin, initial: object = {}) {
  if (ctx.get('loader') === undefined) {
    await ctx.plugin(Loader)
  }
  const name = `live-${Object.keys(ctx.loader.builtins).length}`
  ctx.loader.builtins[name] = plugin
  const options = { id: plugin.name ?? name, name: `cordis:${name}`, config: initial }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const replace = async (next: Record<string, unknown>): Promise<void> => {
    const fiber = entry.fiber!
    resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', next, () => next))
    await entry.update({ config: next })
    await entry.fiber!.await()
  }
  return {
    entry,
    update: (patch: Record<string, unknown>) => replace(merge(entry.options.config as Record<string, unknown>, patch)),
    replace,
  }
}
