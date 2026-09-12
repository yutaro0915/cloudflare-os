import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  InteractUserPluginSurfaceRequest,
  InteractUserPluginSurfaceResult,
  UserPluginInteractiveAction,
  UserPluginInteractiveDocument,
  UserPluginNavigationEntry,
} from '@gadgets/workshop-shared/api'
import { ArrowClockwise, Plus } from '@phosphor-icons/react'
import { useAuthenticatedApi } from './AuthContext'
import { useUserPluginNavigationModel } from './useUserPluginNavigation'
import { useDocumentTitle } from './useDocumentTitle'

interface SurfaceSnapshot {
  revision: number
  document: UserPluginInteractiveDocument
}

type PluginActionRequest = InteractUserPluginSurfaceRequest & {
  interaction: Extract<InteractUserPluginSurfaceRequest['interaction'], {kind: 'action'}>
}

interface PendingPluginAction {
  request: PluginActionRequest
  clearInputOnSuccess: boolean
}

/** Generic trusted renderer for one manifest-owned interactive navigation contribution. */
export function PluginSurfacePage({
  pluginId,
  contributionId,
}: {
  pluginId: string
  contributionId: string
}) {
  const {authenticatedApi} = useAuthenticatedApi()
  const navigation = useUserPluginNavigationModel()
  const [entry, setEntry] = useState<UserPluginNavigationEntry | null>(null)
  const [snapshot, setSnapshot] = useState<SurfaceSnapshot | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingPluginAction | null>(null)
  const generation = useRef(0)
  const operationGeneration = useRef(0)
  const navigationEntry = navigation.entries.find(candidate =>
    candidate.pluginId === pluginId && candidate.contributionId === contributionId)
  const navigationPendingWithoutEntry = navigation.loading && navigationEntry === undefined
  useDocumentTitle(snapshot?.document.title ?? entry?.title ?? 'Plugin')

  const applyResult = useCallback((result: InteractUserPluginSurfaceResult): boolean => {
    if (!result.ok) {
      setError(result.error === 'PLUGIN_UI_CONFLICT'
        ? 'This plugin view changed in another tab. Reloading the latest version.'
        : result.error === 'PLUGIN_UI_BUSY'
          ? 'Plugin execution is busy. Try again in a moment.'
          : result.error === 'PLUGIN_UI_RATE_LIMITED'
            ? 'Plugin execution reached its per-minute limit. Try again shortly.'
            : result.error === 'PLUGIN_UI_STATE_QUOTA_EXCEEDED'
              ? 'This plugin has reached its state storage limit.'
              : 'This plugin is no longer available.')
      if (result.error === 'PLUGIN_UI_NOT_AVAILABLE') setSnapshot(null)
      return false
    }
    setSnapshot(current => current !== null && current.revision > result.revision
      ? current
      : {revision: result.revision, document: result.document})
    setError(null)
    return true
  }, [])

  const open = useCallback(async (
    currentEntry: UserPluginNavigationEntry,
    requestGeneration: number,
  ) => {
    const operation = ++operationGeneration.current
    setRefreshing(true)
    try {
      const result = await authenticatedApi.interactUserPluginSurface({
        pluginId: currentEntry.pluginId,
        expectedInstallationId: currentEntry.installationId,
        expectedPackageVersion: currentEntry.packageVersion,
        contributionId: currentEntry.contributionId,
        interaction: {kind: 'open'},
      })
      if (generation.current !== requestGeneration || operationGeneration.current !== operation) {
        return
      }
      applyResult(result)
    } catch {
      if (generation.current === requestGeneration && operationGeneration.current === operation) {
        setSnapshot(null)
        setError('Could not load this plugin.')
      }
    } finally {
      if (generation.current === requestGeneration && operationGeneration.current === operation) {
        setRefreshing(false)
      }
    }
  }, [applyResult, authenticatedApi])

  useEffect(() => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setSnapshot(null)
    setError(null)
    if (navigationPendingWithoutEntry) return () => { generation.current += 1 }
    const current = navigationEntry ?? null
    setEntry(current)
    if (current === null) {
      setError('This plugin is not installed or is no longer available.')
      setLoading(false)
      return () => { generation.current += 1 }
    }
    void open(current, requestGeneration).finally(() => {
      if (generation.current === requestGeneration) setLoading(false)
    })
    return () => { generation.current += 1 }
  }, [
    contributionId,
    navigationEntry?.contributionId,
    navigationEntry?.installationId,
    navigationEntry?.pluginId,
    navigationPendingWithoutEntry,
    open,
    pluginId,
  ])

  useEffect(() => {
    setPendingAction(null)
  }, [contributionId, entry?.installationId, pluginId])

  useEffect(() => {
    if (
      entry === null || navigationEntry === undefined ||
      entry.pluginId !== navigationEntry.pluginId ||
      entry.installationId !== navigationEntry.installationId ||
      entry.contributionId !== navigationEntry.contributionId ||
      entry.packageVersion === navigationEntry.packageVersion ||
      busy || pendingAction !== null
    ) return
    const requestGeneration = ++generation.current
    setEntry(navigationEntry)
    void open(navigationEntry, requestGeneration)
  }, [
    busy,
    entry,
    navigationEntry,
    open,
    pendingAction,
  ])

  const performAction = async (pending: PendingPluginAction) => {
    if (!entry || !snapshot || busy || refreshing) return
    const requestGeneration = generation.current
    const operation = ++operationGeneration.current
    setBusy(true)
    try {
      const result = await authenticatedApi.interactUserPluginSurface(pending.request)
      if (generation.current !== requestGeneration || operationGeneration.current !== operation) {
        return
      }
      setPendingAction(null)
      if (result.ok && pending.clearInputOnSuccess) setInput('')
      if (!applyResult(result) && !result.ok && result.error === 'PLUGIN_UI_CONFLICT') {
        setBusy(false)
        await open(entry, requestGeneration)
      }
    } catch {
      if (generation.current === requestGeneration && operationGeneration.current === operation) {
        setPendingAction(pending)
        setError('The plugin action failed.')
      }
    } finally {
      if (generation.current === requestGeneration) setBusy(false)
    }
  }

  const act = async (
    action: UserPluginInteractiveAction,
    value: string | null,
    clearInputOnSuccess = false,
  ) => {
    if (!entry || !snapshot || busy || refreshing || pendingAction) return
    await performAction({
      request: {
        pluginId: entry.pluginId,
        expectedInstallationId: entry.installationId,
        expectedPackageVersion: entry.packageVersion,
        contributionId: entry.contributionId,
        interaction: {
          kind: 'action',
          expectedRevision: snapshot.revision,
          mutationId: crypto.randomUUID(),
          actionId: action.actionId,
          input: value,
        },
      },
      clearInputOnSuccess,
    })
  }

  const discardPendingActionAndReload = async () => {
    if (!entry || !pendingAction || busy || refreshing) return
    const latestEntry = navigationEntry !== undefined &&
      navigationEntry.pluginId === entry.pluginId &&
      navigationEntry.installationId === entry.installationId &&
      navigationEntry.contributionId === entry.contributionId
      ? navigationEntry
      : entry
    setPendingAction(null)
    setEntry(latestEntry)
    await open(latestEntry, generation.current)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!snapshot?.document.form || input.trim().length === 0) return
    const form = snapshot.document.form
    await act(
      {actionId: form.actionId, label: form.label, tone: 'neutral'},
      input.trim(),
      true,
    )
  }

  if (loading && !snapshot) {
    return <p className="px-10 py-16 text-center text-[13px] text-kumo-inactive">Loading plugin…</p>
  }
  if (!snapshot) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-lg font-semibold text-kumo-default">Plugin unavailable</h1>
        <p role="alert" className="mt-2 text-[13px] text-kumo-subtle">{error}</p>
      </div>
    )
  }
  const document = snapshot.document
  return (
    <div className="mx-auto w-full max-w-7xl px-6 pb-16 pt-10 sm:px-10">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-kumo-brand">
            Plugin · {pluginId}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-kumo-default">
            {document.title}
          </h1>
          <p className="mt-1 text-[12px] text-kumo-subtle">
            Persistent plugin state · revision {snapshot.revision}
          </p>
        </div>
        <button
          type="button"
          onClick={() => entry && !busy && !refreshing && void open(entry, generation.current)}
          disabled={busy || refreshing || pendingAction !== null}
          className="flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[12px] font-medium text-kumo-default hover:bg-kumo-tint"
        >
          <ArrowClockwise size={14} /> Refresh
        </button>
      </header>

      {document.form && (
        <form onSubmit={submit} className="mb-6 flex max-w-xl gap-2">
          <input
            value={input}
            maxLength={document.form.maxLength}
            disabled={pendingAction !== null}
            onChange={event => setInput(event.target.value)}
            placeholder={document.form.placeholder}
            aria-label={document.form.placeholder}
            className="h-10 min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] text-kumo-default outline-none focus:border-kumo-brand"
          />
          <button
            type="submit"
            disabled={busy || refreshing || pendingAction !== null || input.trim().length === 0}
            className="flex h-10 items-center gap-2 rounded-lg bg-kumo-brand px-4 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            <Plus size={14} weight="bold" /> {document.form.label}
          </button>
        </form>
      )}

      {(error || pendingAction) && (
        <div className="mb-4 flex items-center gap-3">
          {error && <p role="alert" className="text-[12px] text-kumo-danger">{error}</p>}
          {pendingAction && (
            <button
              type="button"
              disabled={busy || refreshing}
              onClick={() => void performAction(pendingAction)}
              className="rounded-md border border-kumo-line px-2 py-1 text-[11px] font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
            >
              Retry action
            </button>
          )}
          {pendingAction && (
            <button
              type="button"
              disabled={busy || refreshing}
              onClick={() => void discardPendingActionAndReload()}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-kumo-subtle hover:bg-kumo-tint disabled:opacity-50"
            >
              Reload latest
            </button>
          )}
        </div>
      )}
      <div
        className="grid gap-4 lg:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]"
        aria-label={document.title}
      >
        {document.columns.map(column => (
          <section key={column.columnId} className="min-h-72 rounded-xl border border-kumo-line bg-kumo-elevated p-3">
            <div className="mb-3 flex items-center justify-between px-1">
              <h2 className="text-[13px] font-semibold text-kumo-default">{column.title}</h2>
              <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] text-kumo-subtle">
                {column.items.length}
              </span>
            </div>
            <div className="space-y-2">
              {column.items.map(item => (
                <article key={item.itemId} className="rounded-lg border border-kumo-line bg-kumo-base p-3 shadow-sm">
                  <p className="text-[13px] font-medium leading-5 text-kumo-default">{item.title}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.actions.map(action => (
                      <button
                        key={action.actionId}
                        type="button"
                        disabled={busy || refreshing || pendingAction !== null}
                        onClick={() => void act(action, null)}
                        className={action.tone === 'danger'
                          ? 'rounded-md px-2 py-1 text-[11px] font-medium text-kumo-danger hover:bg-kumo-danger-tint'
                          : 'rounded-md bg-kumo-tint px-2 py-1 text-[11px] font-medium text-kumo-default hover:bg-kumo-fill'}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
              {column.items.length === 0 && (
                <p className="rounded-lg border border-dashed border-kumo-line px-3 py-8 text-center text-[12px] text-kumo-inactive">
                  No items
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
