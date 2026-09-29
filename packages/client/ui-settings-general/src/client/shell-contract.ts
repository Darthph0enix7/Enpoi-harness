/**
 * Settings shell contract — the types of the `sidebar.settings` occupant this
 * package renders. They live here rather than in ui-settings because they
 * reference the sidebar's own slot type: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { DeviceSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createSettingsShellStore } from './shell-store.ts'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopUpdateView } from './desktop-update-bridge.ts'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): connection state and ledger projections arrive as hook-compartment
 * sources, while the reconnect command remains a plain callback.
 */
export type SettingsRootInjected = {
  /** Clear the explicit onboarding request once the requested flow ran. */
  clearOnboardingRequest: () => void
  /** Request the current shell-owned update action. */
  openDesktopUpdate: () => void
  /**
   * Publish the shell's open-at-a-section handler for the `settingsUi`
   * service; the returned disposer clears it when this occurrence unmounts
   * (a later mount republishes).
   */
  publishOpenSection: (handler: (id: string) => void) => () => void
  /** Request a fresh logical generation and physical WebSocket immediately. */
  reconnect: () => void
  hooks: {
    /**
     * Explicit reopen request raised through the `settingsUi` service: the
     * coordinator mounts the onboarding chain from its first step even with a
     * retained conversation.
     */
    onboardingRequest: HostObservable<{ requested: boolean }>
    /** Shared Electron status for both sidebar locations. */
    desktopUpdate: HostObservable<DesktopUpdateView>
    /** The adaptive classifier: the phone presentation replaces the modal. */
    device: HostObservable<DeviceSnapshot>
    /** Connection-owned state for the current Host connection. */
    connectionState: HostObservable<ConnectionState | undefined>
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * Full component props of the settings shell root: the sidebar owner share
 * (wide/rail state), the declared owner store (modal open state and the active
 * section id, shared with the `settings.open` command), the declared render
 * shares, and the injected face (hooks compartment bound to useSections).
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsStore<ReturnType<typeof createSettingsShellStore>>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>
  & PropsLocale<'settings'>

/** Cross-plugin handle for opening the Settings panel at one registered section. */
export interface SettingsUiService {
  /** Open the panel on `id`; unknown ids fall back to the panel default view. */
  openSection: (id: string) => void
  /**
   * Show the onboarding chain now, from its first step, even with a retained
   * conversation.
   */
  requestOnboarding: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsUi: SettingsUiService
  }
}
