'use client'

import { useCallback, useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
  }
}

/** A search parameter as state, so every view has its own link and Back works. */
export function useUrlParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  )
  const value = allowed.find((a) => a === raw) ?? fallback

  const set = useCallback(
    (next: T) => {
      const url = new URL(window.location.href)
      if (next === fallback) url.searchParams.delete(name)
      else url.searchParams.set(name, next)
      window.history.pushState(null, '', url)
      window.dispatchEvent(new PopStateEvent('popstate'))
    },
    [name, fallback],
  )

  return [value, set]
}
