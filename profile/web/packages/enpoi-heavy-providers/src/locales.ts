/**
 * Host-locale dictionaries for the heavy-provider surfaces.
 *
 * The manifest table stays canonical English: it is the shipped data the
 * client-mirror fixture pins. This module localizes only the product copy an
 * operator reads in Add Provider and the install/removal progress UI — each
 * manifest summary, the reuse/local path labels and notes, and every install
 * and teardown step label. Machine copy stays English by contract: quirks,
 * removal warnings, dependency and disk hints, unsupported reasons, and the
 * shell commands themselves are operator diagnostics, not product wording.
 * zh is the key-set source of truth; en is checked complete against it. The
 * locale resolves from the durable `locale.preference` setting the client
 * writes, with the launch environment as the fallback before one exists.
 *
 * @module dsh-enpoi-heavy-providers/locales
 */

import type { HeavyPlatformInstall, HeavyProviderManifest, HeavyStep } from './manifests.js'
import { resolveHeavyInstall } from './manifests.js'
import type { LocalPathChoice } from './planner.js'

/** Locale ids this surface ships dictionaries for. */
export type HostLocale = 'en' | 'zh'

/**
 * The host locale from the launch environment: an explicit `DSH_LOCALE` wins
 * over the POSIX tags. Anything but a `zh` tag resolves to `en`.
 * @param env - environment to read; defaults to the process environment.
 * @returns the resolved host locale.
 */
export function hostLocale(env: NodeJS.ProcessEnv = process.env): HostLocale {
  const tag = env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? ''
  return /^zh\b/i.test(tag.replaceAll('_', '-')) ? 'zh' : 'en'
}

/**
 * Normalize one durable `locale.preference` value.
 * @param preference - the stored preference, if any.
 * @param env - environment used when no preference is stored.
 * @returns the resolved host locale.
 */
export function localeFromPreference(preference: unknown, env: NodeJS.ProcessEnv = process.env): HostLocale {
  if (typeof preference !== 'string' || preference === '') return hostLocale(env)
  return /^zh\b/i.test(preference.replaceAll('_', '-')) ? 'zh' : 'en'
}

/** Read the durable locale preference from the settings seam, if the namespace is projected. */
export function settingsLocale(
  settings: {
    describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
    describeNamespace?: (ns: string) => { value?: unknown } | undefined
  } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HostLocale {
  try {
    const value = settings?.describeNamespace?.('locale')?.value
      ?? settings?.describe?.().find(entry => entry.ns === 'locale')?.value
    const preference = value !== null && typeof value === 'object'
      ? (value as { preference?: unknown }).preference
      : undefined
    return localeFromPreference(preference, env)
  } catch {
    // A settings read is best-effort: the environment stays the honest fallback.
    return hostLocale(env)
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'summary.freellmapi': '自托管免费额度网关：约 30 个提供方共用一个 OpenAI 兼容端点。',
  'summary.antigravity': '面向 Google Antigravity OAuth 账号的多账号 Anthropic 兼容代理。',
  'summary.commandcode': 'api.commandcode.ai 上 CLI 形态的 Command Code API，由 DSH 提供方包及其原生多密钥池服务——无需代理。',
  'detected.label': '使用检测到的实例',
  'reuse.freellmapi.label': '使用检测到的实例',
  'reuse.freellmapi.note': '零安装：使用本机已在运行的 FreeLLMAPI 实例。',
  'reuse.antigravity.label': '使用检测到的实例',
  'reuse.antigravity.note': '零安装：使用本机已在运行的代理实例及其已配置的账号池。',
  'reuse.commandcode.label': '立即使用厂商端点',
  'reuse.commandcode.note': '确认端点可应答后把路由写到厂商端点；提供方包尚未链接时请先运行本地设置。',
  'local.freellmapi.label': '本地安装（Docker 或 Podman）',
  'local.freellmapi.darwin.label': '本地安装（厂商桌面应用，无需 Docker）',
  'local.freellmapi.win32.label': '本地安装（厂商桌面应用，无需 Docker）',
  'local.antigravity.label': '本地安装（npm + 用户服务）',
  'local.antigravity.linux.label': '本地安装（npm + systemd 用户单元）',
  'local.antigravity.darwin.label': '本地安装（npm + launchd 代理）',
  'local.antigravity.win32.label': 'Windows 不支持',
  'local.commandcode.label': '链接提供方包，然后使用厂商端点',
  'local.commandcode.win32.label': 'Windows 不支持',
  'freellmapi.default.0': '克隆 FreeLLMAPI',
  'freellmapi.default.1': '生成 ENCRYPTION_KEY',
  'freellmapi.default.2': '启动服务栈',
  'freellmapi.default.3': '等待网关就绪',
  'freellmapi.darwin.0': '下载最新 .dmg',
  'freellmapi.darwin.1': '从磁盘映像安装应用',
  'freellmapi.darwin.2': '将桌面应用固定到端口 3002',
  'freellmapi.darwin.3': '启动 FreeLLMAPI',
  'freellmapi.darwin.4': '等待网关就绪',
  'freellmapi.win32.0': '下载最新安装程序',
  'freellmapi.win32.1': '静默安装',
  'freellmapi.win32.2': '将桌面应用固定到端口 3002',
  'freellmapi.win32.3': '启动 FreeLLMAPI',
  'freellmapi.win32.4': '等待网关就绪',
  'freellmapi.removal.0': '停止服务栈并删除其数据卷',
  'freellmapi.removal.1': '删除容器镜像',
  'freellmapi.removal.2': '删除克隆目录',
  'freellmapi.removal.3': '删除 macOS 桌面应用及其数据',
  'freellmapi.removal.4': '删除 Windows 桌面应用及其数据',
  'antigravity.default.0': '安装代理包',
  'antigravity.default.1': '写入 systemd 用户单元',
  'antigravity.default.2': '启用并启动该单元',
  'antigravity.default.3': '启用 lingering（无需登录会话即可启动该单元）',
  'antigravity.default.4': '等待代理就绪',
  'antigravity.linux.0': '安装代理包',
  'antigravity.linux.1': '写入 systemd 用户单元',
  'antigravity.linux.2': '启用并启动该单元',
  'antigravity.linux.3': '启用 lingering（无需登录会话即可启动该单元）',
  'antigravity.linux.4': '等待代理就绪',
  'antigravity.darwin.0': '安装代理包',
  'antigravity.darwin.1': '写入 launchd 代理',
  'antigravity.darwin.2': '加载并启动该代理',
  'antigravity.darwin.3': '等待代理就绪',
  'antigravity.removal.0': '停止并禁用用户服务',
  'antigravity.removal.1': '删除用户服务文件',
  'antigravity.removal.2': '从每个 npm 前缀卸载该包',
  'antigravity.removal.3': '删除 macOS 代理日志',
  'antigravity.removal.4': '删除配置目录（accounts.json OAuth 令牌、用量历史、预设）',
  'antigravity.removal.5': '清理 npm npx 缓存残留',
  'commandcode.default.0': '链接并构建 DSH 提供方包',
  'commandcode.linux.0': '链接并构建 DSH 提供方包',
  'commandcode.darwin.0': '链接并构建 DSH 提供方包',
} satisfies Record<string, string>

/** The heavy-provider text key union. */
export type HeavyTextKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'summary.freellmapi': 'Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.',
  'summary.antigravity': 'Multi-account Anthropic-compatible proxy for Google Antigravity OAuth accounts.',
  'summary.commandcode': 'Command Code\'s CLI-shaped API at api.commandcode.ai, served by the DSH provider package and its native multi-key pool — no proxy.',
  'detected.label': 'Use the detected instance',
  'reuse.freellmapi.label': 'Use a detected instance',
  'reuse.freellmapi.note': 'Zero install: uses a FreeLLMAPI instance already running on this device.',
  'reuse.antigravity.label': 'Use a detected instance',
  'reuse.antigravity.note': 'Zero install: uses the proxy instance already running on this device and its configured account pool.',
  'reuse.commandcode.label': 'Use the vendor endpoint now',
  'reuse.commandcode.note': 'Writes the route at the vendor endpoint after confirming it answers; run the local setup first when the provider package is not linked yet.',
  'local.freellmapi.label': 'Install locally (Docker or Podman)',
  'local.freellmapi.darwin.label': 'Install locally (vendor desktop app, no Docker)',
  'local.freellmapi.win32.label': 'Install locally (vendor desktop app, no Docker)',
  'local.antigravity.label': 'Install locally (npm + user service)',
  'local.antigravity.linux.label': 'Install locally (npm + systemd user unit)',
  'local.antigravity.darwin.label': 'Install locally (npm + launchd agent)',
  'local.antigravity.win32.label': 'Not supported on Windows',
  'local.commandcode.label': 'Link the provider package, then use the vendor endpoint',
  'local.commandcode.win32.label': 'Not supported on Windows',
  'freellmapi.default.0': 'Clone FreeLLMAPI',
  'freellmapi.default.1': 'Generate ENCRYPTION_KEY',
  'freellmapi.default.2': 'Start the stack',
  'freellmapi.default.3': 'Wait for the gateway',
  'freellmapi.darwin.0': 'Download the latest .dmg',
  'freellmapi.darwin.1': 'Install the app from the disk image',
  'freellmapi.darwin.2': 'Pin the desktop app to port 3002',
  'freellmapi.darwin.3': 'Launch FreeLLMAPI',
  'freellmapi.darwin.4': 'Wait for the gateway',
  'freellmapi.win32.0': 'Download the latest installer',
  'freellmapi.win32.1': 'Install silently',
  'freellmapi.win32.2': 'Pin the desktop app to port 3002',
  'freellmapi.win32.3': 'Launch FreeLLMAPI',
  'freellmapi.win32.4': 'Wait for the gateway',
  'freellmapi.removal.0': 'Stop the stack and drop its volume',
  'freellmapi.removal.1': 'Remove the container image',
  'freellmapi.removal.2': 'Remove the clone directory',
  'freellmapi.removal.3': 'Remove the macOS desktop app and its data',
  'freellmapi.removal.4': 'Remove the Windows desktop app and its data',
  'antigravity.default.0': 'Install the proxy package',
  'antigravity.default.1': 'Write the systemd user unit',
  'antigravity.default.2': 'Enable and start the unit',
  'antigravity.default.3': 'Enable lingering (the unit starts without an open login session)',
  'antigravity.default.4': 'Wait for the proxy',
  'antigravity.linux.0': 'Install the proxy package',
  'antigravity.linux.1': 'Write the systemd user unit',
  'antigravity.linux.2': 'Enable and start the unit',
  'antigravity.linux.3': 'Enable lingering (the unit starts without an open login session)',
  'antigravity.linux.4': 'Wait for the proxy',
  'antigravity.darwin.0': 'Install the proxy package',
  'antigravity.darwin.1': 'Write the launchd agent',
  'antigravity.darwin.2': 'Load and start the agent',
  'antigravity.darwin.3': 'Wait for the proxy',
  'antigravity.removal.0': 'Stop and disable the user service',
  'antigravity.removal.1': 'Remove the user service file',
  'antigravity.removal.2': 'Uninstall the package from every npm prefix',
  'antigravity.removal.3': 'Remove the macOS agent logs',
  'antigravity.removal.4': 'Remove the config directory (accounts.json OAuth tokens, usage history, presets)',
  'antigravity.removal.5': 'Remove npm npx cache residue',
  'commandcode.default.0': 'Link and build the DSH provider package',
  'commandcode.linux.0': 'Link and build the DSH provider package',
  'commandcode.darwin.0': 'Link and build the DSH provider package',
} satisfies Record<HeavyTextKey, string>

/** One dictionary lookup; an absent key keeps the code fallback. */
function text(locale: HostLocale, key: string, fallback: string): string {
  const value = (locale === 'zh' ? zh : en)[key as HeavyTextKey]
  return value ?? fallback
}

/** Localize one step list by manifest + variant position. */
function localizeSteps(locale: HostLocale, manifestId: string, variant: string, steps: readonly HeavyStep[]): readonly HeavyStep[] {
  return steps.map((step, index) => ({
    ...step,
    label: text(locale, `${manifestId}.${variant}.${index}`, step.label),
  }))
}

/** Localize one platform variant, including its label override when declared. */
function localizeVariant(
  locale: HostLocale,
  manifestId: string,
  variant: string,
  install: HeavyPlatformInstall,
): HeavyPlatformInstall {
  return {
    ...install,
    ...(install.label === undefined
      ? {}
      : { label: text(locale, `local.${manifestId}.${variant}.label`, install.label) }),
    steps: localizeSteps(locale, manifestId, variant, install.steps),
  }
}

/**
 * Project one manifest into the operator-visible locale: summary, reuse/local
 * path copy, platform variant labels, and every install/teardown step label.
 * Everything else — quirks, warnings, hints, unsupported reasons, commands —
 * stays verbatim machine copy.
 * @param manifest - the canonical manifest row.
 * @param locale - the resolved host locale.
 * @returns the localized manifest copy.
 */
export function localizeHeavyManifest(manifest: HeavyProviderManifest, locale: HostLocale): HeavyProviderManifest {
  if (locale === 'en') return manifest
  return {
    ...manifest,
    summary: text(locale, `summary.${manifest.id}`, manifest.summary),
    reuse: {
      ...manifest.reuse,
      label: text(locale, `reuse.${manifest.id}.label`, manifest.reuse.label),
      note: text(locale, `reuse.${manifest.id}.note`, manifest.reuse.note),
    },
    local: {
      ...manifest.local,
      label: text(locale, `local.${manifest.id}.label`, manifest.local.label),
      install: {
        default: localizeVariant(locale, manifest.id, 'default', manifest.local.install.default),
        ...(manifest.local.install.linux === undefined
          ? {}
          : { linux: localizeVariant(locale, manifest.id, 'linux', manifest.local.install.linux) }),
        ...(manifest.local.install.darwin === undefined
          ? {}
          : { darwin: localizeVariant(locale, manifest.id, 'darwin', manifest.local.install.darwin) }),
        ...(manifest.local.install.win32 === undefined
          ? {}
          : { win32: localizeVariant(locale, manifest.id, 'win32', manifest.local.install.win32) }),
      },
    },
    removal: {
      ...manifest.removal,
      steps: localizeSteps(locale, manifest.id, 'removal', manifest.removal.steps),
    },
  }
}

/**
 * Localize the steps of the platform variant an install will run, keyed by the
 * variant the manifest actually declares for that platform (`default` when it
 * declares none).
 * @param manifest - the canonical manifest row.
 * @param platform - the host platform key.
 * @param steps - the resolved steps about to run.
 * @param locale - the resolved host locale.
 * @returns the localized step copies.
 */
export function localizeHeavySteps(
  manifest: HeavyProviderManifest,
  platform: string,
  steps: readonly HeavyStep[],
  locale: HostLocale,
): readonly HeavyStep[] {
  if (locale === 'en') return steps
  const declared = platform === 'linux' || platform === 'darwin' || platform === 'win32'
    ? manifest.local.install[platform]
    : undefined
  return localizeSteps(locale, manifest.id, declared === undefined ? 'default' : platform, steps)
}

/**
 * Localize the preflight verdict the status endpoint renders: the detected
 * path's label, or the resolved variant's label and steps. Dependency and
 * disk hints stay English machine copy.
 * @param preflight - the canonical verdict from the planner.
 * @param manifest - the localized manifest whose local table the label comes from.
 * @param platform - the host platform key.
 * @param locale - the resolved host locale.
 * @returns the localized verdict copy.
 */
export function localizeHeavyPreflight(
  preflight: LocalPathChoice,
  manifest: HeavyProviderManifest,
  platform: string,
  locale: HostLocale,
): LocalPathChoice {
  if (locale === 'en') return preflight
  if (preflight.path === 'detected') {
    return { ...preflight, label: text(locale, 'detected.label', preflight.label) }
  }
  const resolved = resolveHeavyInstall(manifest.local, platform)
  return { ...preflight, label: resolved.label, steps: resolved.steps }
}
