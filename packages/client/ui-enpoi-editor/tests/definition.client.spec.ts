/**
 * The definition's routing decisions: session-scoped text-ish addresses only,
 * with images, PDFs, and unknown categories left to the fallback preview, and
 * the editor itself demoted below the rich viewer.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import {
  EDITOR_ID, EDITOR_KIND, basenameOf, editorDefinition, editorPreviewDefinition, isEditablePath,
} from '../src/client/definition.ts'

const address = (path: string): string => sessionFileAddress('s1', path)

describe('enpoi-editor definition', () => {
  it('is the fallback-band session-file type under its own id and kind', () => {
    const definition = editorDefinition()
    expect(definition.id).toBe(EDITOR_ID)
    expect(definition.kind).toBe(EDITOR_KIND)
    expect(definition.priority).toBe('fallback')
    // Shorter than the rich viewer's `dsh-resource://file/**`, so the same-band
    // ranking prefers the rich viewer on an automatic open.
    expect(definition.patterns).toEqual(['dsh-resource://**'])
  })

  it('loses an automatic open to the rich viewer and is reached only explicitly', () => {
    const tabs = new SidebarRightTabRegistry(new Context())
    tabs.register({ id: 'rich', kind: 'text', patterns: ['dsh-resource://file/**'], priority: 'fallback', title: () => 'rich' })
    tabs.register(editorDefinition())
    const target = address('notes.md')
    expect(tabs.candidates(target).map(definition => definition.kind)).toEqual(['text', EDITOR_KIND])
    expect(tabs.claim(target, EDITOR_KIND).kind).toBe(EDITOR_KIND)
  })

  it('fails open when the rich viewer is absent', () => {
    const tabs = new SidebarRightTabRegistry(new Context())
    tabs.register(editorDefinition())
    expect(tabs.claim(address('notes.md')).kind).toBe(EDITOR_KIND)
  })

  it('registers an editor-tier document preview that loads its own bytes', () => {
    const definition = editorPreviewDefinition(() => 'Editor')
    expect(definition.id).toBe(EDITOR_ID)
    expect(definition.priority).toBe('editor')
    expect(definition.loading).toBe('renderer')
    expect(definition.extensions).toContain('md')
    expect(definition.extensions).toContain('ts')
    expect(definition.extensions).toContain('html')
  })

  it('opens session text, code, markup, and configuration addresses', () => {
    const canOpen = editorDefinition().canOpen
    for (const path of ['src/index.ts', 'README.md', 'package.json', 'scripts/run.py', 'index.html', 'styles.css', '.gitignore', 'Makefile']) {
      expect(canOpen?.(address(path)), path).toBe(true)
    }
  })

  it('refuses images, PDFs, office documents, video, and unknown binaries', () => {
    const canOpen = editorDefinition().canOpen
    for (const path of ['photo.png', 'scan.pdf', 'report.docx', 'slides.pptx', 'sheet.xlsx', 'clip.mp4', 'archive.zip', 'binary', 'logo.svg']) {
      expect(canOpen?.(address(path)), path).toBe(false)
    }
  })

  it('claims plain-text files the classifier cannot place', () => {
    const canOpen = editorDefinition().canOpen
    for (const path of ['notes.txt', 'app.log', 'LICENSE', 'Cargo.lock', '.bashrc', 'config.yaml', 'script.fish']) {
      expect(canOpen?.(address(path)), path).toBe(true)
    }
  })

  it('refuses absolute addresses, malformed addresses, and the empty workspace path', () => {
    const canOpen = editorDefinition().canOpen
    expect(canOpen?.(absoluteFileAddress('/home/me/notes.md'))).toBe(false)
    expect(canOpen?.('dsh-resource://file/session/s1')).toBe(false)
    expect(canOpen?.('not-an-address')).toBe(false)
    expect(canOpen?.(address(''))).toBe(false)
  })

  it('classifies editable and uneditable paths', () => {
    expect(isEditablePath('main.go')).toBe(true)
    expect(isEditablePath('notes.txt')).toBe(true)
    expect(isEditablePath('LICENSE')).toBe(true)
    expect(isEditablePath('.bashrc')).toBe(true)
    expect(isEditablePath('logo.svg')).toBe(false)
    expect(isEditablePath('photo.jpeg')).toBe(false)
    expect(isEditablePath('unknown-binary')).toBe(false)
  })

  it('titles a tab with the decoded basename', () => {
    expect(basenameOf(address('src/my notes/ähnlich.md'))).toBe('ähnlich.md')
    expect(basenameOf(address('plain.txt'))).toBe('plain.txt')
    // A trailing separator leaves no name: the whole address is the fallback.
    expect(basenameOf('dsh-resource://file/session/s1/')).toBe('dsh-resource://file/session/s1/')
  })
})
