import { useCallback, useEffect, useLayoutEffect, type MutableRefObject, type RefCallback } from 'react'

/**
 * Apply searchable hidden state without unmounting a stable subtree, and
 * optionally hand the same element to a second consumer (a virtualizer's
 * measurement ref) without adding a wrapper element.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's `beforematch` reveal.
 * @param elementRef - caller-owned ref the merged callback keeps current.
 * @param measure - optional additional ref invoked with the same element.
 * @returns the merged callback ref for the stable subtree root.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  elementRef: MutableRefObject<HTMLDivElement | null>,
  measure?: (element: HTMLDivElement | null) => void,
): RefCallback<HTMLDivElement> {
  const setRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element
    measure?.(element)
  }, [elementRef, measure])
  useLayoutEffect(() => {
    const element = elementRef.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    if (hidden) element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
  }, [hidden, reveal, elementRef, setRef])
  useEffect(() => {
    const element = elementRef.current
    if (element === null) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [reveal, elementRef, setRef])
  return setRef
}
