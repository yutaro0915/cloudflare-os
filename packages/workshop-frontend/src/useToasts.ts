import { useRef } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'

type ToastManager = ReturnType<typeof useKumoToastManager>
type StableToasts = { add: ToastManager['add'] }

// Stable-identity wrapper around `useKumoToastManager()`.
//
// The kumo hook returns a new object on every render, and adding a toast re-renders
// every subscriber. A component that lists the manager in a useEffect dependency
// array therefore re-runs that effect whenever any toast appears or expires. If the
// effect reports its own failure via `toasts.add(...)`, this becomes an infinite
// loop: fail -> toast -> re-render -> new identity -> effect re-runs -> fail -> ...
// (Reproducible by opening /agents and dropping the WebSocket connection; the tab
// locks up under a flood of "Failed to load" toasts.)
//
// This wrapper returns the same object across renders, so it is safe to include in
// dependency arrays. Only the write-side `add` is exposed on purpose: reading toast
// state would require subscribing, which is exactly what re-introduces the loop.
export function useToasts(): StableToasts {
  const manager = useKumoToastManager()
  const latest = useRef(manager)
  latest.current = manager
  const stable = useRef<StableToasts>(null)
  stable.current ??= {
    add: (...args: Parameters<ToastManager['add']>) => {
      // Dedupe: while a toast with the same title is still on screen, don't stack
      // another copy. Keeps retry loops (e.g. reconnect attempts) to one visible
      // toast instead of an ever-growing pile.
      const title = (args[0] as {title?: unknown} | undefined)?.title
      const duplicate = title !== undefined &&
        (latest.current.toasts?.some(toast => (toast as {title?: unknown}).title === title) ?? false)
      if (duplicate) return ''
      return latest.current.add(...args)
    },
  }
  return stable.current
}
