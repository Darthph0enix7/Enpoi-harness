// @vitest-environment jsdom
/**
 * The browser-local preferences: the auto-save default, and the redirect's
 * by-path display-type write against the documented viewer-prefs key.
 */
import { describe, expect, it } from 'vitest'
import { AUTOSAVE_KEY, readAutosavePref, writeAutosavePref } from '../src/client/prefs.ts'
import { rememberViewerByPath } from '../src/client/viewer-prefs.ts'

describe('auto-save preference', () => {
  it('reads as on when nothing is stored', () => {
    expect(readAutosavePref()).toBe(true)
  })

  it('round-trips the off choice under the documented key', () => {
    writeAutosavePref(false)
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBe('off')
    expect(readAutosavePref()).toBe(false)
    writeAutosavePref(true)
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBe('on')
    expect(readAutosavePref()).toBe(true)
  })
})

describe('redirect viewer preference', () => {
  it('writes the byPath bucket of the document pane’s preference key', () => {
    rememberViewerByPath('work/notes.md', 'enpoi-editor')
    const stored = JSON.parse(localStorage.getItem('dsh.client.documentPreview.viewerPrefs') ?? '{}') as {
      byPath?: Record<string, string>
    }
    expect(stored.byPath?.['work/notes.md']).toBe('enpoi-editor')
  })

  it('keeps other entries and the suffix bucket intact', () => {
    localStorage.setItem('dsh.client.documentPreview.viewerPrefs', JSON.stringify({
      byExtension: { md: 'markdown' },
      byPath: { 'other.txt': 'plain' },
    }))
    rememberViewerByPath('work/notes.md', 'enpoi-editor')
    const stored = JSON.parse(localStorage.getItem('dsh.client.documentPreview.viewerPrefs') ?? '{}') as {
      byExtension?: Record<string, string>
      byPath?: Record<string, string>
    }
    expect(stored.byExtension?.md).toBe('markdown')
    expect(stored.byPath?.['other.txt']).toBe('plain')
    expect(stored.byPath?.['work/notes.md']).toBe('enpoi-editor')
  })

  it('treats a malformed store as empty rather than failing', () => {
    localStorage.setItem('dsh.client.documentPreview.viewerPrefs', 'not-json')
    expect(() => rememberViewerByPath('work/notes.md', 'enpoi-editor')).not.toThrow()
  })
})
