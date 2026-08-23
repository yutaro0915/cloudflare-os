import {useEffect, useId, useMemo, useRef, useState} from 'react'
import {Pulse, WarningCircle} from '@phosphor-icons/react'
import type {
  Overseer,
  PluginRuntimeStateView,
  PluginRuntimeStatusView,
} from '@gadgets/workshop-shared/api'
import type {RpcStub} from 'capnweb'

const POLL_INTERVAL_MS = 10_000

function readableReason(reason: Extract<PluginRuntimeStateView, {status: 'failed'}>['reason'] |
  Extract<PluginRuntimeStateView, {status: 'suspended'}>['reason']): string {
  return reason.toLowerCase().replaceAll('_', ' ')
}

function statusSummary(status: PluginRuntimeStatusView | null, loadFailed: boolean): {
  label: string
  tone: 'healthy' | 'warning' | 'danger'
} {
  if (loadFailed || status?.outcome === 'refresh-failed') {
    return {label: 'Plugin runtime unavailable', tone: 'danger'}
  }
  if (status?.outcome === 'conflict') return {label: 'Plugin configuration conflict', tone: 'danger'}
  const failed = status?.states.filter(state => state.status === 'failed').length ?? 0
  if (failed > 0) return {label: `${failed} plugin${failed === 1 ? '' : 's'} failed`, tone: 'danger'}
  const suspended = status?.states.filter(state => state.status === 'suspended').length ?? 0
  if (suspended > 0) {
    return {label: `${suspended} plugin${suspended === 1 ? '' : 's'} suspended`, tone: 'warning'}
  }
  const active = status?.states.filter(state => state.status === 'active').length ?? 0
  return {label: `${active} plugin${active === 1 ? '' : 's'} active`, tone: 'healthy'}
}

/** Polls the safe realm projection; it never receives worker, lifecycle, or state authority. */
export default function PluginRuntimeStatusIndicator({overseer}: {overseer: RpcStub<Overseer>}) {
  const [status, setStatus] = useState<PluginRuntimeStatusView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await overseer.getPluginRuntimeStatus()
        if (cancelled) return
        setStatus(next)
        setLoadFailed(false)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [overseer])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  const summary = useMemo(() => statusSummary(status, loadFailed), [status, loadFailed])
  const toneClasses = summary.tone === 'healthy'
    ? 'bg-kumo-success-tint text-kumo-success'
    : summary.tone === 'warning'
      ? 'bg-kumo-warning-tint text-kumo-warning'
      : 'bg-kumo-danger-tint text-kumo-danger'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
        className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium ${toneClasses}`}
      >
        {summary.tone === 'danger'
          ? <WarningCircle size={13} weight="fill" />
          : <Pulse size={13} weight="bold" />}
        <span>{summary.label}</span>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-9 z-50 w-80 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="m-0 text-[12px] font-semibold text-kumo-default">Plugin runtime</p>
            <span className="text-[10px] uppercase tracking-wide text-kumo-inactive">
              {status?.outcome ?? 'unavailable'}
            </span>
          </div>
          {status?.states.length ? (
            <ul className="m-0 space-y-2 p-0" aria-label="Plugin runtime states">
              {status.states.map(state => {
                const identity = state.status === 'active'
                  ? state.active
                  : state.candidate ?? state.retainedActive
                return (
                  <li key={state.pluginId} className="list-none rounded-lg bg-kumo-tint px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-medium text-kumo-default">
                        {state.pluginId}
                      </span>
                      <span className={`text-[10px] font-semibold uppercase ${
                        state.status === 'active' ? 'text-kumo-success' :
                          state.status === 'suspended' ? 'text-kumo-warning' : 'text-kumo-danger'
                      }`}>
                        {state.status}
                      </span>
                    </div>
                    <p className="m-0 mt-1 text-[11px] text-kumo-subtle">
                      {identity ? `Version ${identity.packageVersion}` : 'No active version'}
                      {state.status !== 'active' ? ` · ${readableReason(state.reason)}` : ''}
                    </p>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="m-0 text-[11px] text-kumo-subtle">
              {loadFailed ? 'Runtime status could not be loaded.' : 'No plugins are active in this workspace.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
