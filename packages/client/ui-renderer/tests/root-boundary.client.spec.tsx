// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RootErrorBoundary } from '../src/client/root-boundary.tsx'

interface HealthGlobalFace { fatal(reason: unknown): void }

function setHealthGlobal(face: HealthGlobalFace | undefined): void {
  const globals = globalThis as Record<string, unknown>
  if (face === undefined) delete globals.__DSH_CLIENT_HEALTH__
  else globals.__DSH_CLIENT_HEALTH__ = face
}

function Boom(props: { message: string }): ReactNode {
  throw new Error(props.message)
}

afterEach(() => {
  cleanup()
  setHealthGlobal(undefined)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('RootErrorBoundary', () => {
  it('keeps the fallback mounted and reports the fatal error to the health surface', () => {
    const fatal = vi.fn()
    setHealthGlobal({ fatal })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const view = render(
      <RootErrorBoundary fallback={<div data-testid="fallback" />}>
        <Boom message="root exploded" />
      </RootErrorBoundary>,
    )

    expect(view.getByTestId('fallback')).toBeTruthy()
    expect(error).toHaveBeenCalled()
    expect(fatal).toHaveBeenCalledOnce()
    expect(String(fatal.mock.calls[0]![0])).toContain('root exploded')
  })

  it('renders children while nothing failed', () => {
    const fatal = vi.fn()
    setHealthGlobal({ fatal })
    const view = render(
      <RootErrorBoundary fallback={<div data-testid="fallback" />}>
        <div data-testid="content" />
      </RootErrorBoundary>,
    )
    expect(view.getByTestId('content')).toBeTruthy()
    expect(view.queryByTestId('fallback')).toBeNull()
    expect(fatal).not.toHaveBeenCalled()
  })

  it('survives a missing or throwing health surface', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setHealthGlobal({ fatal: () => { throw new Error('health down') } })
    const view = render(
      <RootErrorBoundary fallback={<div data-testid="fallback" />}>
        <Boom message="still contained" />
      </RootErrorBoundary>,
    )
    expect(view.getByTestId('fallback')).toBeTruthy()
  })

  it('handles a missing health global', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setHealthGlobal(undefined)
    const view = render(
      <RootErrorBoundary fallback={<div data-testid="fallback" />}>
        <Boom message="no health surface" />
      </RootErrorBoundary>,
    )
    expect(view.getByTestId('fallback')).toBeTruthy()
  })
})
