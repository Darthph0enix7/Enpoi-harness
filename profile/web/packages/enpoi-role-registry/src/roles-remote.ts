/**
 * The `enpoiRoles` Remote namespace owner over the shared Typert Gateway.
 *
 * Kept out of the test import graph: the `@Remote` method decorator is
 * compiler-injected metadata that the unit-test transform cannot parse, so the
 * pure projection lives in `roles-view.ts` and only the bundle imports this.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OrchestrationSettingsHandle } from '@deepseek-ai/dsh-tool-subagent'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { effectiveRoleRows, type EffectiveRoleList } from './roles-view'

/**
 * The effective-role remote namespace owner: `enpoiRoles.list()` over the
 * shared Typert Gateway.
 */
export class EnpoiRolesService extends TypertRemoteService {
  /**
   * @param ctx - owning Host Context (the Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiRoles')
  }

  /**
   * Every role the spawn path can resolve, with its effective persona.
   * @returns the effective role list consumed by the Dynamic → Roles panel.
   */
  @Remote
  async list(): Promise<EffectiveRoleList> {
    const settings = this.ctx.get('settings') as SettingsDocumentReader | undefined
    // The engine's role registry reads the shared document through the
    // pre-0.1.7 `get(ns)` handle; adapt the merged describe()-based document
    // onto that handle so settings overrides keep reaching the panel.
    const handle: OrchestrationSettingsHandle = {
      get: () => readOrchestrationDocument(settings),
    }
    return effectiveRoleRows(handle)
  }
}

/**
 * Mount the `enpoiRoles` remote namespace on the owning context.
 * @param ctx - owning plugin context.
 */
export function mountEnpoiRolesRemote(ctx: Context): void {
  ctx.plugin(EnpoiRolesService)
}
