// @vitest-environment jsdom
/**
 * The docs view renders the full manifest: identity, auth mode, the
 * reuse-vs-local comparison with dependency/disk hints, the platform-keyed
 * install steps (switchable, host default), dashboard/docs links, quirks with
 * browser badges, and the install/remove surface.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { HeavyProviderDocs } from '../src/client/HeavyProviderDocs.tsx'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

it('renders every manifest section for the host platform (linux)', () => {
  const manifest = fallbackHeavyManifest('freellmapi')!
  render(<HeavyProviderDocs manifest={manifest} platform="linux" t={t} />)

  expect(screen.getByText(`${manifest.label} · ${en.heavyDocumentation}`)).toBeTruthy()
  expect(screen.getByText(manifest.summary)).toBeTruthy()
  expect(screen.getByText(en.heavyAuthUnified)).toBeTruthy()
  expect(screen.getByText(en.heavyReuseVsLocal)).toBeTruthy()
  expect(screen.getByText(manifest.reuse.label)).toBeTruthy()
  expect(screen.getByText(`${en.heavyDeps}: Docker Engine + Compose`)).toBeTruthy()
  expect(screen.getByText(en.heavyNoLocalFootprint)).toBeTruthy()
  // Loopback dashboards deduplicate to the one local link.
  expect(screen.getByRole('link', { name: `${en.heavyDashboardLocal}: ${manifest.dashboardUrl} ↗` })).toBeTruthy()
  expect(screen.getByRole('link', { name: `${en.heavyDocs}: ${manifest.docsUrl} ↗` })).toBeTruthy()
  expect(screen.getByText(en.heavyPlatformHost.replace('{platform}', 'linux'))).toBeTruthy()
  expect(screen.getByRole('button', { name: en.heavyPlatformLinux }).getAttribute('aria-pressed')).toBe('true')

  // Linux resolves to the vendor one-liner (labels appear in the step list
  // and again in the "what gets installed" summary).
  expect(screen.getAllByText('Run the FreeLLMAPI one-liner').length).toBeGreaterThan(0)
  expect(screen.getByText(/freellmapi\.co\/install\.sh/)).toBeTruthy()
  expect(screen.queryByText('Download the latest .dmg')).toBeNull()

  // Quirks, browser badges, install/remove surface, removal warnings.
  expect(screen.getByText(en.heavyQuirks)).toBeTruthy()
  expect(screen.getByText(/never expose this port beyond the local machine/)).toBeTruthy()
  expect(screen.getAllByText(en.heavyBrowserBadge).length).toBeGreaterThan(0)
  expect(screen.getByText(en.heavyInstalls)).toBeTruthy()
  expect(screen.getByText(en.heavyRemoves)).toBeTruthy()
  expect(screen.getAllByText('Remove the clone directory').length).toBeGreaterThan(0)
  expect(screen.getByText(en.heavyRemoveWarnings)).toBeTruthy()
  expect(screen.getByText(/docker compose down -v/)).toBeTruthy()
})

it('switches the install selection to darwin and win32 samples', () => {
  const manifest = fallbackHeavyManifest('freellmapi')!
  render(<HeavyProviderDocs manifest={manifest} platform="linux" t={t} />)

  fireEvent.click(screen.getByRole('button', { name: en.heavyPlatformMacos }))
  expect(screen.getAllByText('Download the latest .dmg').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Install the app from the disk image').length).toBeGreaterThan(0)
  expect(screen.getByText(`${en.heavyDeps}: macOS 11+`)).toBeTruthy()
  expect(screen.queryByText('Run the FreeLLMAPI one-liner')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: en.heavyPlatformWindows }))
  expect(screen.getAllByText('Download the latest installer').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Install silently').length).toBeGreaterThan(0)
  expect(screen.getByText(`${en.heavyDeps}: Windows 10+`)).toBeTruthy()
  expect(screen.getAllByText(/FreeLLMAPI-Setup\.exe/).length).toBeGreaterThan(0)
})

it('falls back to the default install path for an undeclared platform', () => {
  const manifest = fallbackHeavyManifest('freellmapi')!
  render(<HeavyProviderDocs manifest={manifest} platform="freebsd" t={t} />)
  expect(screen.getByText(en.heavyPlatformFallback)).toBeTruthy()
  expect(screen.getByText(en.heavyPlatformHost.replace('{platform}', 'freebsd'))).toBeTruthy()
  expect(screen.getAllByText(manifest.local.label).length).toBeGreaterThan(0)
  expect(screen.getAllByText('Generate ENCRYPTION_KEY').length).toBeGreaterThan(0)
})

it('renders the placeholder auth reference and the shared keypool removal note', () => {
  const antigravity = fallbackHeavyManifest('antigravity')!
  render(<HeavyProviderDocs manifest={antigravity} platform="linux" t={t} />)
  expect(screen.getByText(en.heavyAuthPlaceholder.replace('{ref}', 'ANTIGRAVITY_API_KEY'))).toBeTruthy()
  cleanup()

  const commandcode = fallbackHeavyManifest('commandcode')!
  render(<HeavyProviderDocs manifest={commandcode} platform="linux" t={t} />)
  expect(screen.getByText(en.heavyAuthNone)).toBeTruthy()
  // The local path is real now: provider package + keypool steps are shown.
  expect(screen.getAllByText('Build and link the DSH provider package').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Drop only pools.commandcode (keypool and other pools stay)').length).toBeGreaterThan(0)
  expect(screen.getByText(/never stops or removes the shared keypool service/)).toBeTruthy()
})
