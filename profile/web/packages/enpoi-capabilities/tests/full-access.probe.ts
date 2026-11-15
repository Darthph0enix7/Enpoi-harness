/**
 * Live probe: Full access = match parent, not a model judgement.
 *
 * Drives the REAL forwarder with the root's effective decision seam and shows
 * that an ordinary Full-access ask is allowed from the root's standing consent
 * with no card and no recommendation/model call.
 *
 * Run (no package build; probe bundle only):
 *   npx esbuild tests/full-access.probe.ts --bundle --format=esm --platform=node \
 *     --target=node22 --external:@deepseek-ai/* --outfile=tests/.full-access.probe.mjs \
 *     && node tests/.full-access.probe.mjs
 */

import { ChildApprovalForwarder, type ChildAgentLike, type ForwardingDeps, type RootHandle } from '../src/forwarding'
import { resolvePolicy } from '../src/policy'

const ROOT: RootHandle = { id: 'root-live', agent: { fake: 'root' }, cwd: '/ws' }

function child(label: string): ChildAgentLike {
  return {
    session: {
      header: { id: 'child-live', parentSession: 'root-live', delegationDepth: 1, cwd: '/ws' },
      ownEvents: () => [{ type: 'subagent/descriptor', data: { label } }],
    },
  }
}

function deps(parentAllowsAsk: boolean, reports: string[]): ForwardingDeps {
  return {
    findRoot: () => ROOT,
    modeOf: () => 'full-access',
    parentAllowsRail: () => false,
    parentAllowsAsk: () => parentAllowsAsk,
    askRoot: () => Promise.reject(new Error('no card exists in Full access')),
    report: line => reports.push(line),
    depthCap: () => 1,
  }
}

async function main(): Promise<void> {
  const decision = resolvePolicy({ toolName: 'str_replace_editor', config: {} })
  if (decision.kind !== 'ask') throw new Error('probe fixture did not ask (editor)')

  for (const allowed of [true, false]) {
    const reports: string[] = []
    const forwarder = new ChildApprovalForwarder(deps(allowed, reports))
    const result = await forwarder.forward({
      agent: child('fixer: probe'), toolName: 'str_replace_editor', args: { file_path: '/ws/a.txt' }, decision,
    })
    console.log(`[full-access parent=${allowed ? 'allow' : 'deny'}]`, JSON.stringify(result))
    console.log('[audit]', reports.find(line => line.startsWith('audit:')))
  }
}

await main()
