/**
 * Embedded dependency-free 3-way merge (§3.2): LCS-class diffing with the
 * diff3 region algorithm.
 *
 * The engine computes matches between the base and each side (patience-anchor
 * LCS with a bounded dynamic-programming fallback), then splits the file at
 * every base line that stays unchanged in BOTH sides. Each region between two
 * sync lines is resolved by the diff3 rules: take the changed side when the
 * other is unchanged, take identical changes once, otherwise emit a conflict.
 * Adjacent different-side changes therefore conflict exactly as GNU diff3
 * does — non-interacting changes separated by a common line merge cleanly.
 */

/** Conflict marker labels. */
export interface MergeLabels {
  /** Label for the local side. */
  ours: string
  /** Label for the pristine base side. */
  base: string
  /** Label for the shipped/theirs side. */
  theirs: string
}

/** Result of a text merge. */
export interface MergeTextResult {
  /** True when no conflict region was produced. */
  clean: boolean
  /** Merged text (conflict markers included when not clean). */
  text: string
  /** Number of conflict regions. */
  conflicts: number
}

const DEFAULT_LABELS: MergeLabels = { ours: 'local', base: 'baseline', theirs: 'shipped' }

/** DP fallback window: ranges with `a * b` at or below this use exact LCS. */
const DP_PRODUCT_LIMIT = 250_000

/**
 * Merge three text versions.
 * @param base - Pristine base text (previous version directory).
 * @param ours - Local text.
 * @param theirs - Shipped text.
 * @param labels - Optional conflict marker labels.
 * @returns Merge result with conflict markers when unresolved.
 */
export function merge3(base: string, ours: string, theirs: string, labels: Partial<MergeLabels> = {}): MergeTextResult {
  const resolved: MergeLabels = { ...DEFAULT_LABELS, ...labels }
  const baseLines = base.split('\n')
  const ourLines = ours.split('\n')
  const theirLines = theirs.split('\n')
  const matchesOurs = lcsMatches(baseLines, ourLines)
  const matchesTheirs = lcsMatches(baseLines, theirLines)
  const theirsByBase = new Map<number, number>(matchesTheirs)
  const syncLines: { base: number; ours: number; theirs: number }[] = []
  for (const [baseIndex, oursIndex] of matchesOurs) {
    const theirsIndex = theirsByBase.get(baseIndex)
    if (theirsIndex !== undefined) syncLines.push({ base: baseIndex, ours: oursIndex, theirs: theirsIndex })
  }

  const out: string[] = []
  let conflicts = 0
  let basePosition = 0
  let oursPosition = 0
  let theirsPosition = 0
  for (const sync of syncLines) {
    conflicts += emitRegion(
      out,
      baseLines.slice(basePosition, sync.base),
      ourLines.slice(oursPosition, sync.ours),
      theirLines.slice(theirsPosition, sync.theirs),
      resolved,
    )
    out.push(ourLines[sync.ours] ?? '')
    basePosition = sync.base + 1
    oursPosition = sync.ours + 1
    theirsPosition = sync.theirs + 1
  }
  conflicts += emitRegion(out, baseLines.slice(basePosition), ourLines.slice(oursPosition), theirLines.slice(theirsPosition), resolved)

  return { clean: conflicts === 0, text: out.join('\n'), conflicts }
}

function emitRegion(out: string[], base: string[], ours: string[], theirs: string[], labels: MergeLabels): number {
  if (equalLines(ours, base)) {
    out.push(...theirs)
    return 0
  }
  if (equalLines(theirs, base)) {
    out.push(...ours)
    return 0
  }
  if (equalLines(ours, theirs)) {
    out.push(...ours)
    return 0
  }
  out.push(`<<<<<<< ${labels.ours}`, ...ours, `||||||| ${labels.base}`, ...base, '=======', ...theirs, `>>>>>>> ${labels.theirs}`)
  return 1
}

function equalLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

type Match = readonly [number, number]

/**
 * Compute matched index pairs between two line arrays via patience anchors
 * with a bounded DP fallback; returns pairs sorted by both indices.
 */
function lcsMatches(a: readonly string[], b: readonly string[]): Match[] {
  return lcsRange(a, b, 0, a.length, 0, b.length)
}

function lcsRange(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): Match[] {
  const prefix: Match[] = []
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
    prefix.push([aStart, bStart])
    aStart++
    bStart++
  }
  const suffix: Match[] = []
  while (aEnd > aStart && bEnd > bStart && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
    suffix.push([aEnd, bEnd])
  }
  suffix.reverse()

  let middle: Match[] = []
  if (aStart < aEnd && bStart < bEnd) {
    const anchors = uniqueAnchors(a, b, aStart, aEnd, bStart, bEnd)
    if (anchors.length > 0) {
      let anchorA = aStart
      let anchorB = bStart
      for (const [matchA, matchB] of anchors) {
        middle.push(...lcsRange(a, b, anchorA, matchA, anchorB, matchB))
        middle.push([matchA, matchB])
        anchorA = matchA + 1
        anchorB = matchB + 1
      }
      middle.push(...lcsRange(a, b, anchorA, aEnd, anchorB, bEnd))
    } else if ((aEnd - aStart) * (bEnd - bStart) <= DP_PRODUCT_LIMIT) {
      middle = dpLcs(a, b, aStart, aEnd, bStart, bEnd)
    } else {
      // No unique anchors and too large for exact DP: treat the ranges as wholly
      // changed. The merge stays correct but coarser (conflicts widen).
      middle = []
    }
  }
  return [...prefix, ...middle, ...suffix]
}

function uniqueAnchors(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): Match[] {
  const aIndex = new Map<string, number>()
  const aCount = new Map<string, number>()
  for (let index = aStart; index < aEnd; index++) {
    const line = a[index] ?? ''
    aCount.set(line, (aCount.get(line) ?? 0) + 1)
    if (!aIndex.has(line)) aIndex.set(line, index)
  }
  const bIndex = new Map<string, number>()
  const bCount = new Map<string, number>()
  for (let index = bStart; index < bEnd; index++) {
    const line = b[index] ?? ''
    bCount.set(line, (bCount.get(line) ?? 0) + 1)
    if (!bIndex.has(line)) bIndex.set(line, index)
  }
  const candidates: Match[] = []
  for (const [line, count] of aCount) {
    if (count !== 1) continue
    if (bCount.get(line) !== 1) continue
    const matchA = aIndex.get(line)
    const matchB = bIndex.get(line)
    if (matchA === undefined || matchB === undefined) continue
    candidates.push([matchA, matchB])
  }
  candidates.sort((left, right) => left[0] - right[0])
  return longestIncreasing(candidates)
}

/** Longest strictly-increasing subsequence over the second index (patience LIS). */
function longestIncreasing(pairs: Match[]): Match[] {
  const tails: number[] = []
  const previous: number[] = new Array<number>(pairs.length).fill(-1)
  const tailIndex: number[] = []
  for (let index = 0; index < pairs.length; index++) {
    const value = pairs[index]?.[1] ?? 0
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((tails[mid] ?? 0) < value) low = mid + 1
      else high = mid
    }
    if (low > 0) previous[index] = tailIndex[low - 1] ?? -1
    tails[low] = value
    tailIndex[low] = index
  }
  const result: Match[] = []
  let cursor = tailIndex[tails.length - 1] ?? -1
  while (cursor >= 0) {
    const pair = pairs[cursor]
    if (pair !== undefined) result.push(pair)
    cursor = previous[cursor] ?? -1
  }
  result.reverse()
  return result
}

function dpLcs(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): Match[] {
  const width = bEnd - bStart
  const table = new Uint32Array((aEnd - aStart + 1) * (width + 1))
  const at = (row: number, column: number): number => table[row * (width + 1) + column] ?? 0
  for (let row = 1; row <= aEnd - aStart; row++) {
    for (let column = 1; column <= width; column++) {
      table[row * (width + 1) + column] = a[aStart + row - 1] === b[bStart + column - 1]
        ? at(row - 1, column - 1) + 1
        : Math.max(at(row - 1, column), at(row, column - 1))
    }
  }
  const matches: Match[] = []
  let row = aEnd - aStart
  let column = width
  while (row > 0 && column > 0) {
    if (a[aStart + row - 1] === b[bStart + column - 1]) {
      matches.push([aStart + row - 1, bStart + column - 1])
      row--
      column--
    } else if (at(row - 1, column) >= at(row, column - 1)) {
      row--
    } else {
      column--
    }
  }
  matches.reverse()
  return matches
}
