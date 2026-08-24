import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { Archive, Package, Plus, ShieldCheck, Trash } from '@phosphor-icons/react'
import type {
  AdminApi,
  StageUserPluginCandidateResult,
  UserPluginAuthoringTemplate,
  UserPluginCenterEntry,
  UserPluginDetachedStateCard,
  UserPluginVersionOffer,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { PluginUiContributionView } from './PluginUiContributions'
import { WorkshopButton } from './components/WorkshopControls'
import { useDocumentTitle } from './useDocumentTitle'
import { useUserPluginCenter, type UserPluginCenterController } from './useUserPluginCenter'

function capabilityApprovalMessage(offer: UserPluginVersionOffer): string {
  if (offer.requestedCapabilities.length === 0) {
    return `Import ${offer.title} ${offer.packageVersion}?`
  }
  return [
    `Import ${offer.title} ${offer.packageVersion} with these capabilities?`,
    '',
    ...offer.requestedCapabilities.map(capability => `• ${capability}`),
  ].join('\n')
}

function PluginCard({entry, controller}: {
  entry: UserPluginCenterEntry
  controller: UserPluginCenterController
}) {
  const installation = entry.installation

  const install = async (offer: UserPluginVersionOffer) => {
    if (!confirm(capabilityApprovalMessage(offer))) return
    try {
      const result = await controller.install({
        pluginId: entry.pluginId,
        packageVersion: offer.packageVersion,
        approvedCapabilities: offer.requestedCapabilities,
      })
      if (!result.ok) {
        alert(result.error === 'PLUGIN_VERSION_NOT_FOUND'
          ? 'That plugin version is no longer available.'
          : 'The approved capabilities no longer match the manifest. Refresh and review them again.')
      }
    } catch {}
  }

  const uninstall = async () => {
    if (!installation) return
    const retention = installation.hasState
      ? ' Its plugin-owned data will be retained until you purge it separately.'
      : ''
    if (!confirm(`Uninstall ${entry.title}?${retention}`)) return
    try {
      const result = await controller.uninstall({
        pluginId: entry.pluginId,
        expectedInstallationId: installation.installationId,
      })
      if (!result.ok) {
        alert('The installation changed. Plugin Center will refresh before you retry.')
        await controller.refresh()
      }
    } catch {}
  }

  return (
    <article className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Package size={17} className="shrink-0 text-kumo-brand" />
            <h2 className="truncate text-[15px] font-semibold text-kumo-default">{entry.title}</h2>
            {installation && (
              <span className="rounded-full bg-kumo-success-tint px-2 py-0.5 text-[10px] font-medium text-kumo-success">
                {installation.lifecycle === 'installed' ? 'Installed' : 'Uninstalling'}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] font-mono text-kumo-inactive">{entry.pluginId}</p>
          <p className="mt-2 max-w-2xl text-[13px] leading-5 text-kumo-subtle">{entry.summary}</p>
          {installation?.catalogAvailability !== undefined && installation.catalogAvailability !== 'available' && (
            <p className="mt-2 text-[12px] text-kumo-warning">
              The exact installed manifest is no longer available. Its embedded UI stays disabled,
              but uninstall remains available.
            </p>
          )}
        </div>
        {installation && (
          <WorkshopButton
            tone="danger"
            onClick={uninstall}
            disabled={controller.mutating}
          >
            <Trash size={13} /> {installation.lifecycle === 'uninstalling' ? 'Resume uninstall' : 'Uninstall'}
          </WorkshopButton>
        )}
      </div>

      {entry.offers.length > 0 && (
        <div className="mt-5 border-t border-kumo-line pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-kumo-inactive">Versions</h3>
          <div className="mt-2 space-y-2">
            {entry.offers.map(offer => {
              const current = installation?.packageVersion === offer.packageVersion
              return (
                <div key={offer.packageVersion} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-kumo-elevated px-3 py-2">
                  <div>
                    <span className="font-mono text-[12px] text-kumo-default">{offer.packageVersion}</span>
                    <span className="ml-2 text-[11px] text-kumo-inactive">
                      {offer.requestedCapabilities.length === 0
                        ? 'No capabilities'
                        : `${offer.requestedCapabilities.length} capabilities`}
                    </span>
                  </div>
                  <WorkshopButton
                    onClick={() => install(offer)}
                    disabled={controller.mutating || current || installation?.lifecycle === 'uninstalling'}
                  >
                    <ShieldCheck size={13} /> {current ? 'Installed' : installation ? 'Update' : 'Import'}
                  </WorkshopButton>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {installation?.lifecycle === 'installed' && installation.contributions.length > 0 && (
        <div className="mt-5 space-y-3 border-t border-kumo-line pt-4">
          {installation.contributions.map(contribution => (
            <PluginUiContributionView
              key={contribution.contributionId}
              contribution={contribution}
              pluginId={entry.pluginId}
              installationId={installation.installationId}
              packageVersion={installation.packageVersion}
              openFrame={controller.openFrame}
            />
          ))}
        </div>
      )}
    </article>
  )
}

const AUTHORING_PRESETS: Record<UserPluginAuthoringTemplate, {
  pluginId: string
  title: string
  summary: string
  surfaceTitle: string
  items: string
}> = {
  'focus-brief': {
    pluginId: 'community.incident-focus',
    title: 'Incident Focus Brief',
    summary: 'A concise, worker-rendered handoff guide for incident response.',
    surfaceTitle: 'Incident handoff ready',
    items: 'Confirm the current impact\nName the next owner\nRecord the next checkpoint',
  },
  'personal-board': {
    pluginId: 'community.release-board',
    title: 'Release Readiness Board',
    summary: 'A persistent three-column board for a release handoff.',
    surfaceTitle: 'Release Board',
    items: 'Run smoke tests\nConfirm rollback owner',
  },
}

function PluginWorkshop({controller}: {controller: UserPluginCenterController}) {
  const {authenticatedApi, isAdmin} = useAuthenticatedApi()
  const [admin, setAdmin] = useState<{api: RpcStub<AdminApi>} | null>(null)
  const [template, setTemplate] = useState<UserPluginAuthoringTemplate>('focus-brief')
  const [draft, setDraft] = useState({...AUTHORING_PRESETS['focus-brief']})
  const [version, setVersion] = useState('1.0.0')
  const [staged, setStaged] = useState<Extract<StageUserPluginCandidateResult, {ok: true}> | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let disposed = false
    let stub: RpcStub<AdminApi> | null = null
    void authenticatedApi.getAdminApi().then(api => {
      if (disposed) api?.[Symbol.dispose]?.()
      else if (api) {
        stub = api
        setAdmin({api})
      }
    })
    return () => {
      disposed = true
      stub?.[Symbol.dispose]?.()
    }
  }, [authenticatedApi, isAdmin])

  if (!isAdmin) return null

  const selectTemplate = (next: UserPluginAuthoringTemplate) => {
    setTemplate(next)
    setDraft({...AUTHORING_PRESETS[next]})
    setStaged(null)
    setStatus('')
  }

  const stage = async () => {
    setBusy(true)
    setStatus('Running isolated checks and signing the immutable candidate…')
    try {
      const result = await authenticatedApi.stageUserPluginCandidate({
        template,
        pluginId: draft.pluginId.trim(),
        packageVersion: version.trim(),
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        surfaceTitle: draft.surfaceTitle.trim(),
        items: draft.items.split('\n').map(item => item.trim()).filter(Boolean),
      })
      if (!result.ok) {
        setStatus(`Candidate rejected: ${result.error}`)
        return
      }
      setStaged(result)
      setStatus('Candidate staged. It is signed, tested, and still hidden from the Store.')
    } catch {
      setStatus('Candidate staging failed.')
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (!staged || !admin) return
    if (!confirm(`Publish exact candidate ${staged.pluginId}@${staged.packageVersion} to every user?`)) return
    setBusy(true)
    setStatus('Publishing the reviewed content-addressed candidate…')
    try {
      const result = await admin.api.approvePluginStoreCandidate(staged.candidateId)
      if (!result.ok) {
        setStatus(`Publication rejected: ${result.error}`)
        return
      }
      await controller.refresh()
      setStatus('Published to the Store. Other users can now import this exact version.')
    } catch {
      setStatus('Publication failed.')
    } finally {
      setBusy(false)
    }
  }

  const fieldClass = 'w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] text-kumo-default outline-none focus:border-kumo-brand'
  return (
    <section data-testid="plugin-workshop" aria-labelledby="plugin-workshop-heading" className="mb-10 rounded-2xl border border-kumo-line bg-kumo-tint p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="plugin-workshop-heading" className="text-[15px] font-semibold text-kumo-default">Plugin Workshop</h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-kumo-subtle">
            Create a bounded package, run it in an isolated Dynamic Worker, then publish only after a separate admin review.
          </p>
        </div>
        <span className="rounded-full bg-kumo-warning-tint px-2.5 py-1 text-[10px] font-semibold text-kumo-warning">ADMIN AUTHORING</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-semibold text-kumo-subtle">Template
          <select data-testid="author-template" className={`${fieldClass} mt-1`} value={template}
            onChange={event => selectTemplate(event.target.value as UserPluginAuthoringTemplate)}>
            <option value="focus-brief">Worker-rendered focus brief</option>
            <option value="personal-board">Persistent personal board</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle">Plugin ID
          <input data-testid="author-plugin-id" className={`${fieldClass} mt-1 font-mono`} value={draft.pluginId}
            onChange={event => setDraft({...draft, pluginId: event.target.value})} />
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle">Title
          <input data-testid="author-title" className={`${fieldClass} mt-1`} value={draft.title}
            onChange={event => setDraft({...draft, title: event.target.value})} />
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle">Version
          <input data-testid="author-version" className={`${fieldClass} mt-1 font-mono`} value={version}
            onChange={event => setVersion(event.target.value)} />
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle sm:col-span-2">Summary
          <input data-testid="author-summary" className={`${fieldClass} mt-1`} value={draft.summary}
            onChange={event => setDraft({...draft, summary: event.target.value})} />
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle">Surface title
          <input data-testid="author-surface-title" className={`${fieldClass} mt-1`} value={draft.surfaceTitle}
            onChange={event => setDraft({...draft, surfaceTitle: event.target.value})} />
        </label>
        <label className="text-[11px] font-semibold text-kumo-subtle">Initial items, one per line
          <textarea data-testid="author-items" className={`${fieldClass} mt-1 min-h-24 resize-y`} value={draft.items}
            onChange={event => setDraft({...draft, items: event.target.value})} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <WorkshopButton data-testid="stage-candidate" onClick={stage} disabled={busy}>
          <Plus size={13} /> Create &amp; test candidate
        </WorkshopButton>
        <WorkshopButton data-testid="publish-candidate" onClick={publish} disabled={busy || !staged || !admin}>
          <ShieldCheck size={13} /> Review &amp; publish
        </WorkshopButton>
        {staged && <code className="max-w-full truncate text-[10px] text-kumo-inactive">{staged.manifestDigest}</code>}
      </div>
      {status && <p data-testid="authoring-status" role="status" className="mt-3 text-[12px] text-kumo-subtle">{status}</p>}
    </section>
  )
}

function DetachedStateCard({state, controller}: {
  state: UserPluginDetachedStateCard
  controller: UserPluginCenterController
}) {
  const purge = async () => {
    if (!confirm(`Permanently purge retained data from ${state.title}? This cannot be undone.`)) return
    try {
      const result = await controller.purge({installationId: state.installationId})
      if (!result.ok) await controller.refresh()
    } catch {}
  }

  return (
    <article className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Archive size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-medium text-kumo-default">{state.title}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-kumo-inactive">
            {state.pluginId} · {state.packageVersion}
          </p>
        </div>
      </div>
      <WorkshopButton
        tone="danger"
        onClick={purge}
        disabled={controller.mutating}
      >
        <Trash size={13} /> {state.lifecycle === 'purging' ? 'Resume purge' : 'Purge data'}
      </WorkshopButton>
    </article>
  )
}

export function PluginsPage() {
  useDocumentTitle('Plugin Store')
  const {authenticatedApi} = useAuthenticatedApi()
  const controller = useUserPluginCenter(authenticatedApi)

  if (controller.loading && !controller.view) {
    return <p className="px-10 py-16 text-center text-[13px] text-kumo-inactive">Loading Plugin Center…</p>
  }

  if (!controller.view) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-lg font-semibold text-kumo-default">Plugin Center is unavailable</h1>
        <p className="mt-2 text-[13px] text-kumo-subtle">{controller.error ?? 'The complete catalog snapshot could not be loaded.'}</p>
        <WorkshopButton className="mt-4" onClick={controller.refresh}>Retry</WorkshopButton>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-10 sm:px-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Plugin Store</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-5 text-kumo-subtle">
          Import exact human-reviewed versions, inspect their declared capabilities, and manage retained plugin data.
        </p>
        <div className="mt-4 max-w-2xl rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3">
          <p className="text-[12px] font-semibold text-kumo-default">Publication authority is locked</p>
          <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
            Candidates stay invisible while the host verifies their content digests, isolated execution evidence, and
            signature. Only a deployment admin can publish them.
          </p>
        </div>
        {controller.error && <p role="alert" className="mt-3 text-[12px] text-kumo-danger">{controller.error}</p>}
      </header>

      <PluginWorkshop controller={controller} />

      <section aria-labelledby="plugin-catalog-heading">
        <h2 id="plugin-catalog-heading" className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Human-reviewed catalog
        </h2>
        {controller.view.plugins.length === 0 ? (
          <div className="rounded-xl border border-dashed border-kumo-line px-6 py-12 text-center text-[13px] text-kumo-inactive">
            No plugins are available in this deployment.
          </div>
        ) : (
          <div className="space-y-4">
            {controller.view.plugins.map(entry => (
              <PluginCard key={entry.pluginId} entry={entry} controller={controller} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="retained-state-heading" className="mt-10">
        <h2 id="retained-state-heading" className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Retained data
        </h2>
        <p className="mb-3 text-[12px] text-kumo-subtle">
          Uninstall keeps state detached until you explicitly and permanently purge it.
        </p>
        {controller.view.detachedStates.length === 0 ? (
          <p className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[12px] text-kumo-inactive">
            No retained plugin data.
          </p>
        ) : (
          <div className="space-y-2">
            {controller.view.detachedStates.map(state => (
              <DetachedStateCard key={state.installationId} state={state} controller={controller} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
