/**
 * Type-only Electron update declarations shared by the settings UI and Desktop
 * compatibility checks.
 *
 * The declarations live with their only runtime consumer, the settings row's
 * optional preload bridge (`./client/desktop-update-bridge.ts`); this module is
 * the package's published `./types` re-export so a Desktop consumer can reach
 * them without a deep relative import.
 */
export type {
  DesktopUpdateBridge,
  DesktopUpdateFailureKind,
  DesktopUpdatePresentation,
  DesktopUpdateView,
} from './client/desktop-update-bridge.ts'
