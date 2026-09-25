// @vitest-environment jsdom
/** The onboarding artwork loads from a deferred chunk and stays decorative on failure. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OnboardingIllustration } from '../src/client/OnboardingIllustration.tsx'

afterEach(cleanup)

function deferred() {
  let resolve: (value: string) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<string>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject, module: () => promise.then(value => ({ default: value })) }
}

describe('OnboardingIllustration', () => {
  it('renders both theme variants once the deferred chunks load', async () => {
    const { container } = render(<OnboardingIllustration art={{
      light: () => Promise.resolve({ default: 'light.png' }),
      dark: () => Promise.resolve({ default: 'dark.png' }),
    }} />)
    await act(async () => {})
    const images = [...container.querySelectorAll('img')]
    expect(images.map(image => image.getAttribute('src'))).toEqual(['light.png', 'dark.png'])
  })

  it('keeps the container without images when a chunk fails', async () => {
    const { container } = render(<OnboardingIllustration art={{
      light: () => Promise.reject(new Error('offline')),
      dark: () => Promise.resolve({ default: 'dark.png' }),
    }} />)
    await act(async () => {})
    expect(container.querySelector('[class*="illustration"]')).not.toBeNull()
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('drops a late load after unmount', async () => {
    const art = deferred()
    const view = render(<OnboardingIllustration art={{ light: art.module, dark: art.module }} />)
    view.unmount()
    art.resolve('late.png')
    await act(async () => {})
  })

  it('drops a late failure after unmount', async () => {
    const art = deferred()
    const view = render(<OnboardingIllustration art={{ light: art.module, dark: art.module }} />)
    view.unmount()
    art.reject(new Error('late'))
    await act(async () => {})
  })
})
