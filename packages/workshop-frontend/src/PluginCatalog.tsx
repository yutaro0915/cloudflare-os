import { useState } from 'react'
import { Archive, Package, ShieldCheck, Trash, Warning } from '@phosphor-icons/react'
import type {
  UserPluginCenterEntry,
  UserPluginDetachedStateCard,
  UserPluginVersionOffer,
} from '@gadgets/workshop-shared/api'
import { PluginUiContributionView } from './PluginUiContributions'
import { WorkshopButton } from './components/WorkshopControls'
import type { UserPluginCenterController } from './useUserPluginCenter'

export function PluginCatalogCard({entry, controller}: {
  entry: UserPluginCenterEntry
  controller: UserPluginCenterController
}) {
  const installation = entry.installation
  const [pendingOffer, setPendingOffer] = useState<UserPluginVersionOffer | null>(null)
  const [confirmingUninstall, setConfirmingUninstall] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const install = async (offer: UserPluginVersionOffer) => {
    setActionError(null)
    try {
      const result = await controller.install({
        pluginId: entry.pluginId,
        packageVersion: offer.packageVersion,
        approvedCapabilities: offer.requestedCapabilities,
      })
      if (!result.ok) {
        setActionError(result.error === 'PLUGIN_VERSION_NOT_FOUND'
          ? 'That plugin version is no longer available. Refresh the catalog and choose another version.'
          : 'The requested capabilities changed. Refresh the catalog and review the package again.')
        return
      }
      setPendingOffer(null)
    } catch {
      setActionError('The plugin could not be imported. Your existing installation was not changed.')
    }
  }

  const uninstall = async () => {
    if (!installation) return
    setActionError(null)
    try {
      const result = await controller.uninstall({
        pluginId: entry.pluginId,
        expectedInstallationId: installation.installationId,
      })
      if (!result.ok) {
        setActionError('The installation changed. The catalog was refreshed; review it before retrying.')
        await controller.refresh()
        return
      }
      setConfirmingUninstall(false)
    } catch {
      setActionError('The plugin could not be uninstalled. Access and retained data were not changed.')
    }
  }

  return (
    <article className="plugin-store-card rounded-2xl border p-5 shadow-sm">
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
            onClick={installation.lifecycle === 'uninstalling'
              ? uninstall
              : () => {
                setActionError(null)
                setConfirmingUninstall(true)
              }}
            disabled={controller.mutating}
          >
            <Trash size={13} /> {installation.lifecycle === 'uninstalling' ? 'Resume uninstall' : 'Uninstall'}
          </WorkshopButton>
        )}
      </div>

      {actionError && (
        <p role="alert" className="mt-4 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-3 py-2 text-[12px] text-kumo-danger">
          {actionError}
        </p>
      )}

      {confirmingUninstall && installation?.lifecycle === 'installed' && (
        <div data-testid="uninstall-review" className="mt-4 rounded-xl border border-kumo-warning bg-kumo-warning-tint px-4 py-4">
          <div className="flex items-start gap-3">
            <Warning size={18} className="mt-0.5 shrink-0 text-kumo-warning" />
            <div>
              <h3 className="text-[13px] font-semibold text-kumo-default">Review uninstall</h3>
              <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                Access to {entry.title} will be revoked and its navigation entry will disappear.
                {installation.hasState
                  ? ' Plugin-owned data will be detached and retained. It is not deleted by uninstall.'
                  : ' This plugin owns no retained state.'}
              </p>
              <p className="mt-2 font-mono text-[11px] text-kumo-inactive">
                {entry.pluginId}@{installation.packageVersion} · lifecycle {installation.installationId}
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <WorkshopButton onClick={() => setConfirmingUninstall(false)} disabled={controller.mutating}>Cancel</WorkshopButton>
            <WorkshopButton data-testid="confirm-uninstall" tone="danger" onClick={uninstall} disabled={controller.mutating}>
              Uninstall and retain data
            </WorkshopButton>
          </div>
        </div>
      )}

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
                    onClick={() => {
                      setActionError(null)
                      setPendingOffer(offer)
                    }}
                    disabled={controller.mutating || current || installation?.lifecycle === 'uninstalling'}
                  >
                    <ShieldCheck size={13} /> {current ? 'Installed' : installation ? 'Update' : 'Import'}
                  </WorkshopButton>
                </div>
              )
            })}
          </div>
          {pendingOffer && (
            <div data-testid="import-review" className="plugin-store-review mt-3 rounded-xl border px-4 py-4">
              <div className="flex items-start gap-3">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-kumo-brand" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[13px] font-semibold text-kumo-default">Review exact package before import</h3>
                  <p className="mt-1 font-mono text-[12px] text-kumo-default">
                    {entry.pluginId}@{pendingOffer.packageVersion}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="rounded-lg bg-kumo-base px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">Capabilities</p>
                      {pendingOffer.requestedCapabilities.length === 0 ? (
                        <p className="mt-1 text-[12px] text-kumo-subtle">None</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {pendingOffer.requestedCapabilities.map(capability => (
                            <li key={capability} className="font-mono text-[11px] text-kumo-default">{capability}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="rounded-lg bg-kumo-base px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">Dependencies</p>
                      {pendingOffer.dependencies.length === 0 ? (
                        <p className="mt-1 text-[12px] text-kumo-subtle">None</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {pendingOffer.dependencies.map(dependency => (
                            <li key={dependency} className="font-mono text-[11px] text-kumo-default">{dependency}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="rounded-lg bg-kumo-base px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">Uninstall behavior</p>
                      <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                        {pendingOffer.hasState ? 'State is retained until a separate purge.' : 'No plugin state is retained.'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <WorkshopButton onClick={() => setPendingOffer(null)} disabled={controller.mutating}>Cancel</WorkshopButton>
                <WorkshopButton data-testid="confirm-import" tone="primary" onClick={() => install(pendingOffer)} disabled={controller.mutating}>
                  Approve capabilities &amp; import
                </WorkshopButton>
              </div>
            </div>
          )}
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

export function DetachedPluginStateCard({state, controller}: {
  state: UserPluginDetachedStateCard
  controller: UserPluginCenterController
}) {
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const purge = async () => {
    setActionError(null)
    try {
      const result = await controller.purge({installationId: state.installationId})
      if (!result.ok) {
        setActionError('The retained lifecycle changed. The catalog was refreshed; review it before retrying.')
        await controller.refresh()
        return
      }
      setConfirmingPurge(false)
    } catch {
      setActionError('The retained data could not be purged. No data was deleted.')
    }
  }

  return (
    <article className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Archive size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-medium text-kumo-default">{state.title}</h3>
            <p className="mt-0.5 font-mono text-[11px] text-kumo-inactive">
              {state.pluginId} · {state.packageVersion}
            </p>
            <p className="mt-1 text-[11px] text-kumo-subtle">Detached state retained after uninstall</p>
          </div>
        </div>
        <WorkshopButton
          tone="danger"
          onClick={state.lifecycle === 'purging'
            ? purge
            : () => {
              setActionError(null)
              setConfirmingPurge(true)
            }}
          disabled={controller.mutating}
        >
          <Trash size={13} /> {state.lifecycle === 'purging' ? 'Resume purge' : 'Purge data'}
        </WorkshopButton>
      </div>
      {actionError && (
        <p role="alert" className="mt-3 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-3 py-2 text-[12px] text-kumo-danger">
          {actionError}
        </p>
      )}
      {confirmingPurge && state.lifecycle === 'detached' && (
        <div data-testid="purge-review" className="mt-3 rounded-xl border border-kumo-danger bg-kumo-danger-tint p-4">
          <div className="flex items-start gap-3">
            <Warning size={18} className="mt-0.5 shrink-0 text-kumo-danger" />
            <div>
              <h4 className="text-[13px] font-semibold text-kumo-default">Permanently delete retained plugin data</h4>
              <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                This is separate from uninstall and cannot be undone. The retained lifecycle
                {` ${state.installationId} `}will be destroyed.
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <WorkshopButton onClick={() => setConfirmingPurge(false)} disabled={controller.mutating}>Keep retained data</WorkshopButton>
            <WorkshopButton data-testid="confirm-purge" tone="danger" onClick={purge} disabled={controller.mutating}>
              Permanently purge data
            </WorkshopButton>
          </div>
        </div>
      )}
    </article>
  )
}
