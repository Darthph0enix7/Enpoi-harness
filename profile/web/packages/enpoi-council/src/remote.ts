/**
 * enpoi-council — Host RPC surface for the council UI.
 *
 * The `enpoiCouncil` Typert Remote namespace is a read-only projection of the
 * settings-backed registry (see `registry.ts:councilListView`): the client
 * renders council seats dynamically from `list()` — the same seat ids the
 * engine resolves through `enpoi-orchestration.personas`. The value is read
 * fresh per call, so a settings write is visible without a reload.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { councilListView, type CouncilListView } from './registry.ts'

/**
 * The council remote namespace owner: `enpoiCouncil.list()` over the shared
 * Typert Gateway.
 */
export class EnpoiCouncilService extends TypertRemoteService {
  /**
   * @param ctx - owning Host Context (the Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiCouncil')
  }

  /**
   * Every known council with its seats and enabled state.
   * @returns the council list payload consumed by the client.
   */
  @Remote
  async list(): Promise<CouncilListView> {
    return councilListView(this.ctx)
  }
}

/**
 * Mount the `enpoiCouncil` remote namespace on the owning context.
 * @param ctx - owning plugin context.
 */
export function mountEnpoiCouncilRemote(ctx: Context): void {
  ctx.plugin(EnpoiCouncilService)
}
