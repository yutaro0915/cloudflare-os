import { Archive, Package, ShieldCheck, Trash } from '@phosphor-icons/react'
import type {
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
    return `Install ${offer.title} ${offer.packageVersion}?`
  }
  return [
    `Install ${offer.title} ${offer.packageVersion} with these capabilities?`,
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
                    <ShieldCheck size={13} /> {current ? 'Installed' : installation ? 'Update' : 'Install'}
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
          Install exact human-reviewed versions, inspect their declared capabilities, and manage retained plugin data.
        </p>
        <div className="mt-4 max-w-2xl rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3">
          <p className="text-[12px] font-semibold text-kumo-default">AI publishing is locked</p>
          <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
            Packages enter this Store only through reviewed source and a deployment build. Agents receive no authoring,
            publishing, or installation authority.
          </p>
        </div>
        {controller.error && <p role="alert" className="mt-3 text-[12px] text-kumo-danger">{controller.error}</p>}
      </header>

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
