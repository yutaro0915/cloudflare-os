import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthenticatedApi,
  InstallUserPluginRequest,
  InstallUserPluginResult,
  OpenUserPluginUiFrameRequest,
  OpenUserPluginUiFrameResult,
  PurgeUserPluginStateRequest,
  PurgeUserPluginStateResult,
  UninstallUserPluginRequest,
  UninstallUserPluginResult,
  UserPluginCenterView,
} from '@gadgets/workshop-shared/api'

/** Narrow remote interface owned by the Plugin Center controller. */
export type UserPluginCenterApi = Pick<AuthenticatedApi,
  | 'getUserPluginCenter'
  | 'installUserPlugin'
  | 'uninstallUserPlugin'
  | 'purgeUserPluginState'
  | 'openUserPluginUiFrame'
>

/** Browser state and exact owner mutations exposed to the Plugin Center page. */
export interface UserPluginCenterController {
  /** Latest complete server-owned projection, or null before the first successful load. */
  view: UserPluginCenterView | null

  /** Whether the first projection is still loading. */
  loading: boolean

  /** Latest load or mutation failure safe to render in the trusted host UI. */
  error: string | null

  /** Whether one owner mutation is pending. */
  mutating: boolean

  /** Reloads the complete projection and ignores stale responses. */
  refresh(): Promise<void>

  /** Installs one exact catalog offer, then refreshes on success. */
  install(request: InstallUserPluginRequest): Promise<InstallUserPluginResult>

  /** Uninstalls one exact observed lifecycle, then refreshes on success. */
  uninstall(request: UninstallUserPluginRequest): Promise<UninstallUserPluginResult>

  /** Purges one exact detached lifecycle, then refreshes on success. */
  purge(request: PurgeUserPluginStateRequest): Promise<PurgeUserPluginStateResult>

  /** Lazily opens one exact current sandbox contribution. */
  openFrame(request: OpenUserPluginUiFrameRequest): Promise<OpenUserPluginUiFrameResult>
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin Center request failed'
}

/** Keeps browser state thin while the backend owns joining, lifecycle derivation, and sorting. */
export function useUserPluginCenter(api: UserPluginCenterApi): UserPluginCenterController {
  const [view, setView] = useState<UserPluginCenterView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mutating, setMutating] = useState(false)
  const requestGeneration = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestGeneration.current += 1
    }
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const next = await api.getUserPluginCenter()
      if (!mounted.current || generation !== requestGeneration.current) return
      setView(next)
      setError(null)
    } catch (caught) {
      if (!mounted.current || generation !== requestGeneration.current) return
      setError(messageFor(caught))
    } finally {
      if (mounted.current && generation === requestGeneration.current) setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = useCallback(async (request: InstallUserPluginRequest) => {
    setMutating(true)
    setError(null)
    try {
      const result = await api.installUserPlugin(request)
      if (result.ok) await refresh()
      return result
    } catch (caught) {
      if (mounted.current) setError(messageFor(caught))
      throw caught
    } finally {
      if (mounted.current) setMutating(false)
    }
  }, [api, refresh])

  const uninstall = useCallback(async (request: UninstallUserPluginRequest) => {
    setMutating(true)
    setError(null)
    try {
      const result = await api.uninstallUserPlugin(request)
      if (result.ok) await refresh()
      return result
    } catch (caught) {
      if (mounted.current) setError(messageFor(caught))
      throw caught
    } finally {
      if (mounted.current) setMutating(false)
    }
  }, [api, refresh])

  const purge = useCallback(async (request: PurgeUserPluginStateRequest) => {
    setMutating(true)
    setError(null)
    try {
      const result = await api.purgeUserPluginState(request)
      if (result.ok) await refresh()
      return result
    } catch (caught) {
      if (mounted.current) setError(messageFor(caught))
      throw caught
    } finally {
      if (mounted.current) setMutating(false)
    }
  }, [api, refresh])

  const openFrame = useCallback(
    (request: OpenUserPluginUiFrameRequest) => api.openUserPluginUiFrame(request),
    [api],
  )

  return {view, loading, error, mutating, refresh, install, uninstall, purge, openFrame}
}
