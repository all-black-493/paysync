'use client'

import { useCallback, useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
  }
}

/** Change search parameters in place: push for navigation, replace for closing things. */
export function navigate(params: Record<string, string | null>, mode: 'push' | 'replace' = 'push'): void {
  const url = new URL(window.location.href)
  for (const [name, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(name)
    else url.searchParams.set(name, value)
  }
  if (mode === 'push') window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** The href `navigate` would produce, for real links (open in a new tab, copy link). */
export function hrefWith(params: Record<string, string | null>): string {
  const search = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  for (const [name, value] of Object.entries(params)) {
    if (value === null) search.delete(name)
    else search.set(name, value)
  }
  const query = search.toString()
  return query ? `?${query}` : '?'
}

export function useSearchParam(name: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  )
}

/** A search parameter as state, so every view has its own link and Back works. */
export function useUrlParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const raw = useSearchParam(name)
  const value = allowed.find((a) => a === raw) ?? fallback
  const set = useCallback(
    (next: T) => {
      navigate({ [name]: next === fallback ? null : next })
    },
    [name, fallback],
  )
  return [value, set]
}
