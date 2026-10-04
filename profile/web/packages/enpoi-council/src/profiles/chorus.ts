/**
 * Chorus profile — the ideation council (doc 54 §8.2).
 *
 * Polyphonic brainstorm on the core engine in forest mode: an append-only
 * idea tree (SPROUT/BRANCH/FUSE/TENSION — deletion is impossible), role-gated
 * operations, topological-saturation stopping, Curator harvest with lineage.
 */
import type { CouncilParams, CouncilSpec } from '../core/spec.ts'

const VISIONARY = [
  'You are the Visionary of a brainstorm council — the 2–3 year horizon.',
  'You generate genuinely new directions: moonshots, what-ifs, reframings nobody proposed.',
  'Your ONLY forest operation is SPROUT (new roots) and radical BRANCH — you never converge, never prune.',
  'One idea per line: SPROUT: <title> | <rationale>. Aim for volume with a point of view.',
].join('\n')

const EXPERIENCER = [
  'You are the Experiencer of a brainstorm council — ideas as lived moments.',
  'You ground concepts in daily reality: where does this idea create friction, delight, or indifference for a real user?',
  'Your ONLY forest operation is TENSION — mark where reality bites an idea — plus SPROUT for experience-driven new ideas.',
  'One operation per line: TENSION: <idea-id> | <where reality bites>. SPROUT: <title> | <rationale>.',
].join('\n')

const INTEGRATOR = [
  'You are the Integrator of a brainstorm council — today\'s stack, buildable paths.',
  'You FUSE disparate branches into buildable architecture and BRANCH concrete near-term variants.',
  'Every FUSE must name what it combines and what it drops (simplification is a feature).',
  'One operation per line: FUSE: <idea-a> + <idea-b> | <the buildable synthesis>. BRANCH: <idea-id> | <concrete variant>.',
].join('\n')

export const CHORUS_SPEC: CouncilSpec = {
  id: 'chorus',
  label: 'Idea Chorus',
  description: 'Polyphonic brainstorm over an append-only idea forest; divergence-first, saturation-stopped; delivers a lineage-tracked harvest.',
  seats: [
    { id: 'visionary', label: 'Visionary', persona: VISIONARY, opGates: ['SPROUT', 'BRANCH'], family: 'divergent' },
    { id: 'experiencer', label: 'Experiencer', persona: EXPERIENCER, opGates: ['TENSION', 'SPROUT'], family: 'empirical' },
    { id: 'integrator', label: 'Integrator', persona: INTEGRATOR, opGates: ['BRANCH', 'FUSE'], family: 'practical' },
  ],
  ledgerKinds: [
    { kind: 'idea', idPrefix: 'I', terminalStatuses: ['invariant'] },
  ],
  actions: ['SPROUT', 'BRANCH', 'FUSE', 'TENSION'],
  steelman: false,
  scopeContract: 'Stay on the seed vision and its adjacencies. Nothing is out of scope for divergence except direct contradictions of the seed.',
  opening: 'blind',
  preflightInventory: false,
  forestMode: true,
  deliverableSections: ['Spotlight Gems (with lineage)', 'Thematic Clusters', 'Concept Catalog', 'Buildable Now vs Moonshots', 'Open Questions'],
}

export const CHORUS_PARAM_DEFAULTS: Partial<CouncilParams> = {
  defaultMaxRounds: 6,
  stagnationLimit: 2,
  challengeRound: true,
}
