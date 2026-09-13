/**
 * The definition's routing decisions: session-scoped text-ish addresses only,
 * with images, PDFs, and unknown categories left to the fallback preview.
 */
import { describe, expect, it } from 'vitest'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { EDITOR_ID, EDITOR_KIND, basenameOf, editorDefinition, isEditablePath } from '../src/client/definition.ts'

const address = (path: string): string => sessionFileAddress('s1', path)

describe('enpoi-editor definition', () => {
  it('is the extension-band session-file type under its own id and kind', () => {
    const definition = editorDefinition()
    expect(definition.id).toBe(EDITOR_ID)
    expect(definition.kind).toBe(EDITOR_KIND)
    expect(definition.priority).toBe('extension')
    expect(definition.patterns).toEqual(['dsh-resource://file/**'])
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
