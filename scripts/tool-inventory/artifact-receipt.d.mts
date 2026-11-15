/**
 * Declarations for scripts/tool-inventory/artifact-receipt.mjs: the test-only
 * artifact receipt shared by the keyless inventory capture and the profile
 * fixture gate.
 */

/** One package's identity, tracked manifest digest and declared entry digest. */
export interface ArtifactPackageReceipt {
  name: string
  version: string | null
  packageJson: string | null
  entry: string | null
}

/** One external profile dependency; `missing` marks an unresolvable install. */
export interface ExternalBundleReceipt {
  version: string | null
  packageJson: string | null
  entry: string | null
  missing?: boolean
}

/** One local profile package's fingerprint inputs and compiled output digest. */
export interface ProfileFingerprintReceipt {
  dir: string
  sourceInputs: string | null
  outputSha: string | null
}

/** Canonical receipt document; `head` is informational and excluded from the digest. */
export interface ArtifactReceipt {
  version: string | null
  head: string | null
  profileFingerprints: Record<string, ProfileFingerprintReceipt>
  externalBundles: Record<string, ExternalBundleReceipt>
  hostPackages: Record<string, ArtifactPackageReceipt>
  combinedDigest: string
}

/**
 * Build the canonical artifact receipt for a checkout.
 * @param repoRoot - Repository root.
 * @returns The receipt with its combined digest.
 */
export function buildArtifactReceipt(repoRoot: string): Promise<ArtifactReceipt>
