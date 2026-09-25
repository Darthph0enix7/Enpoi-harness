// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandedDocumentTitle, installDocumentBrand } from '../src/client/document-brand.ts'

/** One observer delivery: MutationObserver callbacks drain on a later task. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Install one icon link into the document head. */
function addIcon(href: string, media?: string): HTMLLinkElement {
  const link = document.createElement('link')
  link.rel = 'icon'
  link.setAttribute('href', href)
  if (media !== undefined) link.setAttribute('media', media)
  document.head.append(link)
  return link
}

describe('brandedDocumentTitle', () => {
  it('replaces an exact upstream product title', () => {
    expect(brandedDocumentTitle('DeepSeek Harness')).toBe('Enpoi Harness')
    expect(brandedDocumentTitle('DSH Local Build')).toBe('Enpoi Harness')
  })

  it('keeps a session-title prefix and replaces only the product suffix', () => {
    expect(brandedDocumentTitle('Into the Unknown — DeepSeek Harness')).toBe('Into the Unknown — Enpoi Harness')
  })

  it('leaves the fork title and unrelated titles untouched', () => {
    expect(brandedDocumentTitle('Enpoi Harness')).toBe('Enpoi Harness')
    expect(brandedDocumentTitle('Session — Something Else')).toBe('Session — Something Else')
  })
})

describe('installDocumentBrand', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    document.title = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    dispose?.()
    dispose = undefined
    for (const link of [...document.querySelectorAll('link[rel~="icon"]')]) link.remove()
  })

  it('repoints an upstream dark icon link at the fork monogram and leaves other links alone', () => {
    const dark = addIcon('./favicon-dark.svg', '(prefers-color-scheme: dark)')
    const light = addIcon('./favicon.svg', '(prefers-color-scheme: light)')
    const stylesheet = document.createElement('link')
    stylesheet.rel = 'stylesheet'
    stylesheet.setAttribute('href', './favicon-dark.svg')
    document.head.append(stylesheet)
    dispose = installDocumentBrand()
    expect(dark.getAttribute('href')).toBe('./favicon.svg')
    expect(light.getAttribute('href')).toBe('./favicon.svg')
    expect(stylesheet.getAttribute('href')).toBe('./favicon-dark.svg')
  })

  it('rewrites the current upstream title immediately', () => {
    document.title = 'DSH Local Build'
    dispose = installDocumentBrand()
    expect(document.title).toBe('Enpoi Harness')
  })

  it('re-applies the fork product title after a later shell write', async () => {
    dispose = installDocumentBrand()
    document.title = 'Into the Unknown — DeepSeek Harness'
    await settle()
    expect(document.title).toBe('Into the Unknown — Enpoi Harness')
  })

  it('stops observing after disposal', async () => {
    dispose = installDocumentBrand()
    dispose()
    dispose = undefined
    document.title = 'DeepSeek Harness'
    await settle()
    expect(document.title).toBe('DeepSeek Harness')
  })

  it('installs nothing without a document', () => {
    vi.stubGlobal('document', undefined)
    dispose = installDocumentBrand()
    expect(dispose).toBeTypeOf('function')
  })

  it('observes nothing without a title element or MutationObserver', () => {
    for (const title of [...document.querySelectorAll('title')]) title.remove()
    vi.stubGlobal('MutationObserver', undefined)
    dispose = installDocumentBrand()
    expect(dispose).toBeTypeOf('function')
  })
})
