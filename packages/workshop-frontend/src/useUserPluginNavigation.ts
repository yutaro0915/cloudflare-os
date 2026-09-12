import { useEffect, useState } from 'react'
import type { AuthenticatedApi, UserPluginNavigationEntry } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from './AuthContext'

const navigationRequestByApi = new WeakMap<object, Promise<UserPluginNavigationEntry[]>>()
const refreshListeners = new Set<() => void>()

/** Shares one navigation request across the sidebar and the active plugin route. */
export function loadUserPluginNavigation(
  api: Pick<AuthenticatedApi, 'listUserPluginNavigation'>,
): Promise<UserPluginNavigationEntry[]> {
  const key: object = api
  let request = navigationRequestByApi.get(key)
  if (!request) {
    request = api.listUserPluginNavigation()
    navigationRequestByApi.set(key, request)
    request.catch(() => {
      if (navigationRequestByApi.get(key) === request) navigationRequestByApi.delete(key)
    })
  }
  return request
}

/** Invalidates the safe navigation read model after an owner installation lifecycle changes. */
export function refreshUserPluginNavigation(api: object): void {
  navigationRequestByApi.delete(api)
  for (const listener of refreshListeners) listener()
}

/** Returns current manifest-derived sidebar entries without browser-side joins or route authority. */
export function useUserPluginNavigationModel(): {
  entries: UserPluginNavigationEntry[]
  loading: boolean
} {
  const auth = useOptionalAuthenticatedApi()
  const [entries, setEntries] = useState<UserPluginNavigationEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const listener = () => setRefreshTick(value => value + 1)
    refreshListeners.add(listener)
    return () => { refreshListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!auth) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    const request = loadUserPluginNavigation(auth.authenticatedApi)
    let cancelled = false
    request.then(value => {
      if (!cancelled) setEntries(value)
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [auth, refreshTick])

  return {entries, loading}
}

/** Returns current manifest-derived sidebar entries. */
export function useUserPluginNavigation(): UserPluginNavigationEntry[] {
  return useUserPluginNavigationModel().entries
}
