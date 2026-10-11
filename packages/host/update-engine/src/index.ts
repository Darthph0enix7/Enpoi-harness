/**
 * Public surface of the update engine (P2 of the optimal install/update
 * design): manifest hashing, classification and planning, the embedded
 * 3-way merge, staged apply with journal and qualified verification, the
 * pre-update backup latch, and reporting.
 */

export * from './types.ts'
export * from './atomic.ts'
export * from './manifest.ts'
export * from './glob.ts'
export * from './pins.ts'
export * from './diff3.ts'
export * from './plan.ts'
export * from './journal.ts'
export * from './verify.ts'
export * from './backup.ts'
export * from './report.ts'
export * from './apply.ts'
