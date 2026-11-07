/** Global terminal-dock toggle bridge shared by the rail control and shortcuts. */
export function installTerminalDockToggle(toggle: () => void): () => void {
  if (typeof window === 'undefined') return () => { /* server/no-DOM face has nothing to remove */ }
  const listener = (): void => { toggle() }
  window.addEventListener('enpoi-toggle-terminal-dock', listener)
  return () => { window.removeEventListener('enpoi-toggle-terminal-dock', listener) }
}
