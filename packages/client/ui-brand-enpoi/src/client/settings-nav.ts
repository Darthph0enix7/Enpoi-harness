/**
 * In-package bridge between the settings sections the fork owns: Dynamic and
 * Permissions cross-link to each other, so a section body needs a way to
 * switch the settings shell's active section. The shell owns the open state
 * and publishes its `openSection` handler through the `settingsUi` service;
 * `apply` installs it here once, and components call the plain function.
 */

let handler: ((id: string) => void) | null = null

/**
 * Publish the shell's open-at-a-section handler for the section bodies.
 * @param next - the handler, or null when the publisher unmounts.
 * @returns disposer clearing the handler.
 */
export function setOpenSettingsSection(next: ((id: string) => void) | null): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/**
 * Open the settings panel at one registered section id.
 * @param id - section id (`permissions`, `dynamic`, …).
 */
export function openSettingsSection(id: string): void {
  handler?.(id)
}
