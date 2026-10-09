/**
 * Locale-copy invariants for the terminal host errors: zh/en key parity, the
 * session-cap refusal in both locales, and the environment resolution.
 */
import { describe, expect, it } from 'vitest'
import { TerminalHostError, TerminalRegistry } from '../src/pty.ts'
import { en, zh, hostLocale, terminalText } from '../src/locales.ts'

describe('terminal locale copy', () => {
  it('declares the same keys in zh and en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('renders the session-limit refusal in the resolved locale', () => {
    const registry = new TerminalRegistry({ maxPerSession: 0, locale: () => 'zh' })
    let caught: unknown
    try {
      registry.open({ key: 'session:tab', sessionId: 'session' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TerminalHostError)
    expect((caught as TerminalHostError).code).toBe('session-limit')
    expect((caught as TerminalHostError).message).toBe('一个会话最多可以运行 0 个终端')
    expect((caught as TerminalHostError).status).toBe(429)
  })

  it('keeps the English copy byte-identical', () => {
    expect(terminalText('en', 'sessionLimit', { max: '8' })).toBe('at most 8 terminals may run in one session')
    expect(terminalText('en', 'sessionLimit', { max: '1' })).toBe('at most 1 terminals may run in one session')
  })

  it('resolves the locale from the launch environment', () => {
    expect(hostLocale({ DSH_LOCALE: 'zh-TW' })).toBe('zh')
    expect(hostLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(hostLocale({ LANG: 'en_US.UTF-8' })).toBe('en')
    expect(hostLocale({})).toBe('en')
  })
})
