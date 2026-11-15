/**
 * Shared coarse-pointer target classes. A control adds `hitTargetClass` when its
 * painted box must stay (the hit layer is an invisible 44px pseudo-element) or
 * `hitBlockTargetClass` when the control itself may grow to 44px on touch.
 * Both carry `touch-action: manipulation`; fine pointers are untouched.
 * @module @deepseek-ai/dsh-client-ui-primitives/hit-target
 */
import css from './HitTarget.module.css'

/** Keeps the visual box; a centred transparent pseudo grows the tap target to 44px. */
export const hitTargetClass: string = css['target'] ?? ''

/** Makes the element itself at least 44 by 44 on coarse pointers. */
export const hitBlockTargetClass: string = css['blockTarget'] ?? ''
