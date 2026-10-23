/**
 * Locale-copy invariants for the heavy-provider surfaces: zh/en key parity,
 * the machine-copy boundary, and the settings/environment locale resolution.
 */
import { describe, expect, it } from 'vitest'
import { HEAVY_MANIFESTS, manifestById, resolveHeavyInstall } from '../src/manifests.js'
import {
  en, zh, hostLocale, localeFromPreference, localizeHeavyManifest, localizeHeavyPreflight,
  localizeHeavySteps, settingsLocale,
} from '../src/locales.js'
import { chooseLocalPath } from '../src/planner.js'

describe('heavy-provider locale copy', () => {
  it('declares the same keys in zh and en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('carries zh copy for every shipped manifest summary, path, and step', () => {
    const dictionary = zh as Record<string, string>
    for (const manifest of HEAVY_MANIFESTS) {
      expect(dictionary[`summary.${manifest.id}`], `${manifest.id} summary`).toBeDefined()
      expect(dictionary[`reuse.${manifest.id}.label`], `${manifest.id} reuse label`).toBeDefined()
      expect(dictionary[`reuse.${manifest.id}.note`], `${manifest.id} reuse note`).toBeDefined()
      expect(dictionary[`local.${manifest.id}.label`], `${manifest.id} local label`).toBeDefined()
      for (const platform of ['default', 'linux', 'darwin', 'win32'] as const) {
        const variant = manifest.local.install[platform]
        if (variant === undefined) continue
        // `default` carries no locale key of its own: it inherits the local
        // label unless a manifest overrides it, and antigravity's override is
        // the one shipped variant whose default label falls back to English.
        if (variant.label !== undefined && platform !== 'default') {
          expect(dictionary[`local.${manifest.id}.${platform}.label`], `${manifest.id} ${platform} label`).toBeDefined()
        }
        variant.steps.forEach((_step, index) => {
          expect(dictionary[`${manifest.id}.${platform}.${index}`], `${manifest.id} ${platform} step ${String(index)}`).toBeDefined()
        })
      }
      manifest.removal.steps.forEach((_step, index) => {
        expect(dictionary[`${manifest.id}.removal.${index}`], `${manifest.id} removal step ${String(index)}`).toBeDefined()
      })
    }
  })

  it('localizes summaries, path labels, and step labels; machine copy stays English', () => {
    const canonical = manifestById('freellmapi')!
    const localized = localizeHeavyManifest(canonical, 'zh')
    expect(localized.summary).toBe(zh['summary.freellmapi'])
    expect(localized.reuse.label).toBe(zh['reuse.freellmapi.label'])
    expect(localized.reuse.note).toBe(zh['reuse.freellmapi.note'])
    expect(localized.local.label).toBe(zh['local.freellmapi.label'])
    expect(localized.local.install.darwin?.label).toBe(zh['local.freellmapi.darwin.label'])
    expect(localized.local.install.default.steps.map(step => step.label))
      .toEqual(['克隆 FreeLLMAPI', '生成 ENCRYPTION_KEY', '启动服务栈', '等待网关就绪'])
    expect(localized.removal.steps[0]?.label).toBe(zh['freellmapi.removal.0'])
    // Machine copy is deliberately untouched: quirks, warnings, hints, commands.
    expect(localized.quirks).toEqual(canonical.quirks)
    expect(localized.removal.warnings).toEqual(canonical.removal.warnings)
    expect(localized.local.diskHint).toBe(canonical.local.diskHint)
    expect(localized.local.install.default.steps.map(step => step.command))
      .toEqual(canonical.local.install.default.steps.map(step => step.command))
    // English returns the canonical table untouched, so shipped defaults stay byte-identical.
    expect(localizeHeavyManifest(canonical, 'en')).toBe(canonical)
  })

  it('localizes the install steps the job runner receives, platform variant or default', () => {
    const manifest = manifestById('antigravity')!
    const linux = resolveHeavyInstall(manifest.local, 'linux').steps
    expect(localizeHeavySteps(manifest, 'linux', linux, 'zh').map(step => step.label)[0]).toBe('安装代理包')
    const unknown = resolveHeavyInstall(manifest.local, 'sunos').steps
    expect(localizeHeavySteps(manifest, 'sunos', unknown, 'zh').map(step => step.label)[0]).toBe('安装代理包')
  })

  it('localizes the preflight verdict against the localized manifest', () => {
    const canonical = manifestById('commandcode')!
    const preflight = chooseLocalPath(canonical, 'linux', {
      docker: false, podman: false, node: true, nodeMajor: 22, systemdUser: true,
    })
    const localized = localizeHeavyPreflight(
      preflight,
      localizeHeavyManifest(canonical, 'zh'),
      'linux',
      'zh',
    )
    expect(localized.label).toBe(zh['local.commandcode.label'])
    expect(localized.steps[0]?.label).toBe('链接并构建 DSH 提供方包')
    // Dependency and disk hints stay English machine copy.
    expect(localized.deps).toEqual(preflight.deps)
    expect(localized.diskHint).toBe(preflight.diskHint)
  })

  it('resolves the locale from the durable preference, then the environment', () => {
    expect(localeFromPreference('zh-CN')).toBe('zh')
    expect(localeFromPreference('en')).toBe('en')
    expect(localeFromPreference(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(hostLocale({ DSH_LOCALE: 'zh-TW' })).toBe('zh')
    expect(hostLocale({ LANG: 'en_US.UTF-8' })).toBe('en')
    expect(settingsLocale({ describe: () => [{ ns: 'locale', value: { preference: 'zh' } }] })).toBe('zh')
    expect(settingsLocale({ describeNamespace: () => ({ value: { preference: 'zh' } }) })).toBe('zh')
    expect(settingsLocale(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh')
  })
})
