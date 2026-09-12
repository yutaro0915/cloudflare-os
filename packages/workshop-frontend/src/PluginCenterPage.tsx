import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { CheckCircle, Eye, FileCode, LockKey, Plus, ShieldCheck, Warning } from '@phosphor-icons/react'
import type {
  AdminApi,
  StageUserPluginCandidateResult,
  UserPluginAuthoringTemplate,
  UserPluginCandidateVerificationCheck,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { DetachedPluginStateCard, PluginCatalogCard } from './PluginCatalog'
import { WorkshopButton } from './components/WorkshopControls'
import { useDocumentTitle } from './useDocumentTitle'
import { useUserPluginCenter, type UserPluginCenterController } from './useUserPluginCenter'

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

const VERIFICATION_LABELS = {
  'manifest-schema-verified': 'Manifest schema verified',
  'artifact-digests-verified': 'Executable artifact digests verified',
  'dynamic-worker-isolation-passed': 'Dynamic Worker isolation contracts passed',
  'candidate-signature-verified': 'Candidate signature verified',
} satisfies Record<UserPluginCandidateVerificationCheck, string>

function DraftPluginPreview({template, title, items}: {
  template: UserPluginAuthoringTemplate
  title: string
  items: string[]
}) {
  return (
    <aside data-testid="author-draft-preview" className="sticky top-6 overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
      <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-kumo-inactive">Live draft output</p>
          <p className="mt-0.5 text-[12px] text-kumo-subtle">Host preview before executable packaging</p>
        </div>
        <Eye size={17} className="text-kumo-brand" />
      </div>
      <div className="p-4">
        {template === 'focus-brief' ? (
          <div className="rounded-xl border border-kumo-line bg-kumo-tint p-4">
            <p className="rounded-lg border border-kumo-brand bg-kumo-base px-3 py-2 text-[13px] font-semibold text-kumo-default">
              {title || 'Untitled brief'}
            </p>
            <ol className="mt-3 space-y-2">
              {items.map((item, index) => (
                <li key={`${item}-${index}`} className="flex items-start gap-2 text-[12px] leading-5 text-kumo-subtle">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-kumo-elevated text-[10px] font-semibold text-kumo-default">
                    {index + 1}
                  </span>
                  {item}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div>
            <h3 className="text-[16px] font-semibold text-kumo-default">{title || 'Untitled board'}</h3>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {['To do', 'Doing', 'Done'].map((column, columnIndex) => (
                <div key={column} className="min-h-32 rounded-lg border border-kumo-line bg-kumo-tint p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">{column}</p>
                  {columnIndex === 0 && items.map((item, index) => (
                    <div key={`${item}-${index}`} className="mt-2 rounded-md border border-kumo-line bg-kumo-base px-2 py-2 text-[11px] leading-4 text-kumo-default shadow-sm">
                      {item}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
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
  const [confirmingPublish, setConfirmingPublish] = useState(false)
  const [published, setPublished] = useState(false)

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
    setConfirmingPublish(false)
    setPublished(false)
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
      setConfirmingPublish(false)
      setPublished(false)
      setStatus('Candidate staged. It is signed, tested, and still hidden from the Store.')
    } catch {
      setStatus('Candidate staging failed.')
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (!staged || !admin) return
    setBusy(true)
    setStatus('Publishing the reviewed content-addressed candidate…')
    try {
      const result = await admin.api.approvePluginStoreCandidate(staged.candidateId)
      if (!result.ok) {
        setStatus(`Publication rejected: ${result.error}`)
        return
      }
      await controller.refresh()
      setPublished(true)
      setConfirmingPublish(false)
      setStatus('Published to the Store. Other users can now import this exact version.')
    } catch {
      setStatus('Publication failed.')
    } finally {
      setBusy(false)
    }
  }

  const items = draft.items.split('\n').map(item => item.trim()).filter(Boolean)
  const fieldClass = 'w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-[14px] text-kumo-default outline-none focus:border-kumo-brand'
  return (
    <section data-testid="plugin-workshop" aria-labelledby="plugin-workshop-heading" className="mb-10 rounded-2xl border border-kumo-line bg-kumo-tint p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="plugin-workshop-heading" className="text-[18px] font-semibold text-kumo-default">Build a real plugin package</h2>
          <p className="mt-1 max-w-3xl text-[13px] leading-5 text-kumo-subtle">
            Define the output, generate executable artifacts, run them inside an isolated Dynamic Worker,
            inspect the immutable package, and publish only through a separate admin approval.
          </p>
        </div>
        <span className="rounded-full bg-kumo-warning-tint px-2.5 py-1 text-[10px] font-semibold text-kumo-warning">ADMIN AUTHORING</span>
      </div>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kumo-contrast text-[11px] font-semibold text-kumo-inverse">1</span>
            <h3 className="text-[13px] font-semibold text-kumo-default">Define the package and its output</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] font-semibold text-kumo-subtle">Plugin type
              <select data-testid="author-template" className={`${fieldClass} mt-1`} value={template}
                onChange={event => selectTemplate(event.target.value as UserPluginAuthoringTemplate)}>
                <option value="focus-brief">Worker-rendered incident runbook</option>
                <option value="personal-board">Persistent release board</option>
              </select>
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle">Plugin ID
              <input data-testid="author-plugin-id" className={`${fieldClass} mt-1 font-mono`} value={draft.pluginId}
                onChange={event => setDraft({...draft, pluginId: event.target.value})} />
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle">Catalog title
              <input data-testid="author-title" className={`${fieldClass} mt-1`} value={draft.title}
                onChange={event => setDraft({...draft, title: event.target.value})} />
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle">Exact version
              <input data-testid="author-version" className={`${fieldClass} mt-1 font-mono`} value={version}
                onChange={event => setVersion(event.target.value)} />
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle sm:col-span-2">Catalog summary
              <input data-testid="author-summary" className={`${fieldClass} mt-1`} value={draft.summary}
                onChange={event => setDraft({...draft, summary: event.target.value})} />
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle">Plugin surface title
              <input data-testid="author-surface-title" className={`${fieldClass} mt-1`} value={draft.surfaceTitle}
                onChange={event => setDraft({...draft, surfaceTitle: event.target.value})} />
            </label>
            <label className="text-[12px] font-semibold text-kumo-subtle">Initial content, one item per line
              <textarea data-testid="author-items" className={`${fieldClass} mt-1 min-h-28 resize-y`} value={draft.items}
                onChange={event => setDraft({...draft, items: event.target.value})} />
            </label>
          </div>
          <div className="mt-4 rounded-xl border border-kumo-line bg-kumo-base p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kumo-contrast text-[11px] font-semibold text-kumo-inverse">2</span>
              <h3 className="text-[13px] font-semibold text-kumo-default">Generate executable artifacts and isolate-test them</h3>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-kumo-subtle">
              The host creates the manifest and code artifacts from this bounded definition. Nothing is published by this action.
            </p>
            <WorkshopButton className="mt-3" tone="primary" data-testid="stage-candidate" onClick={stage} disabled={busy}>
              <Plus size={13} /> {busy && !staged ? 'Building candidate…' : 'Build & isolate-test candidate'}
            </WorkshopButton>
          </div>
        </div>
        <DraftPluginPreview template={template} title={draft.surfaceTitle} items={items} />
      </div>
      {status && <p data-testid="authoring-status" role="status" className="mt-4 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[12px] text-kumo-subtle">{status}</p>}

      {staged && (
        <div data-testid="candidate-review" className="mt-6 rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-kumo-contrast text-[11px] font-semibold text-kumo-inverse">3</span>
              <div>
                <h3 className="text-[15px] font-semibold text-kumo-default">Review the immutable candidate</h3>
                <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                  Inspect the exact package and passed checks before using the separate publication authority.
                </p>
              </div>
            </div>
            <span data-testid="candidate-visibility" className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${published
              ? 'bg-kumo-success-tint text-kumo-success'
              : 'bg-kumo-warning-tint text-kumo-warning'}`}>
              {published ? 'PUBLISHED TO EVERY USER' : 'UNPUBLISHED · HIDDEN FROM STORE'}
            </span>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-kumo-default">
                <FileCode size={16} className="text-kumo-brand" /> Generated manifest projection
              </div>
              <pre data-testid="candidate-manifest" className="mt-2 max-h-72 overflow-auto rounded-xl bg-kumo-elevated p-4 text-[11px] leading-5 text-kumo-default">{JSON.stringify({
                pluginId: staged.pluginId,
                packageVersion: staged.packageVersion,
                title: staged.review.title,
                requestedCapabilities: staged.review.requestedCapabilities,
                state: staged.review.state,
                uiContribution: {
                  title: staged.review.surfaceTitle,
                  renderer: staged.review.renderer,
                },
                artifactDigests: staged.review.artifactDigests,
              }, null, 2)}</pre>
            </div>
            <div>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-kumo-default">
                <LockKey size={16} className="text-kumo-brand" /> Host verification evidence
              </div>
              <ul data-testid="candidate-checks" className="mt-2 space-y-2">
                {staged.review.verificationChecks.map(check => (
                  <li key={check} className="flex items-start gap-2 rounded-lg border border-kumo-line px-3 py-2 text-[12px] leading-5 text-kumo-default">
                    <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-success" />
                    {VERIFICATION_LABELS[check]}
                  </li>
                ))}
              </ul>
              <div className="mt-3 rounded-lg bg-kumo-elevated px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">Manifest digest</p>
                <code className="mt-1 block break-all text-[10px] leading-4 text-kumo-subtle">{staged.manifestDigest}</code>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">Candidate content address</p>
                <code className="mt-1 block break-all text-[10px] leading-4 text-kumo-subtle">{staged.candidateId}</code>
              </div>
            </div>
          </div>

          {!published && !confirmingPublish && (
            <WorkshopButton className="mt-5" data-testid="open-publication-review" onClick={() => setConfirmingPublish(true)} disabled={busy || !admin}>
              <ShieldCheck size={13} /> Continue to publication approval
            </WorkshopButton>
          )}
          {!published && confirmingPublish && (
            <div data-testid="publication-review" className="mt-5 rounded-xl border border-kumo-warning bg-kumo-warning-tint p-4">
              <div className="flex items-start gap-3">
                <Warning size={18} className="mt-0.5 shrink-0 text-kumo-warning" />
                <div>
                  <h4 className="text-[13px] font-semibold text-kumo-default">Final deployment-admin approval</h4>
                  <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                    Publishing makes {staged.pluginId}@{staged.packageVersion} visible and importable by every user.
                    The immutable candidate content address above is the exact version that will be published.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <WorkshopButton onClick={() => setConfirmingPublish(false)} disabled={busy}>Back to review</WorkshopButton>
                <WorkshopButton data-testid="confirm-publication" tone="primary" onClick={publish} disabled={busy || !admin}>
                  {busy ? 'Publishing…' : 'Approve exact candidate & publish'}
                </WorkshopButton>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
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
    <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-10 sm:px-10">
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
              <PluginCatalogCard key={entry.pluginId} entry={entry} controller={controller} />
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
              <DetachedPluginStateCard key={state.installationId} state={state} controller={controller} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
