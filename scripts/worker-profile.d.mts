export function workerBundleDirectory(release: string): string
export function workerManifest(release: string): {
  version: number
  hash: string
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}
export function seedWorkerProfile(release: string, home: string): string
