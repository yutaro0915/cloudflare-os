import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOut } from '@phosphor-icons/react'
import type {
  OpenUserPluginUiFrameRequest,
  OpenUserPluginUiFrameResult,
  UserPluginDeclarativeDocument,
  UserPluginUiContribution,
  UserPluginUiFrame,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'

/** Narrow lazy frame opener used by the sandbox contribution adapter. */
export type PluginUiFrameOpener = (
  request: OpenUserPluginUiFrameRequest,
) => Promise<OpenUserPluginUiFrameResult>

function DeclarativePluginUi({document}: {document: UserPluginDeclarativeDocument}) {
  return (
    <div className="space-y-3 text-[13px] leading-5 text-kumo-default">
      {document.blocks.map((block, index) => {
        switch (block.kind) {
          case 'text':
            return <p key={index} className="whitespace-pre-wrap">{block.text}</p>
          case 'notice':
            return (
              <p
                key={index}
                className={block.tone === 'warning'
                  ? 'rounded-lg border border-kumo-warning bg-kumo-warning-tint px-3 py-2'
                  : 'rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2'}
              >
                {block.text}
              </p>
            )
          case 'list':
            return (
              <ul key={index} className="list-disc space-y-1 pl-5">
                {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
              </ul>
            )
        }
      })}
    </div>
  )
}

function WorkerRenderedPluginUi({
  contribution,
  pluginId,
  installationId,
  packageVersion,
  openFrame,
}: {
  contribution: Extract<UserPluginUiContribution, {kind: 'worker-rendered'}>
  pluginId: string
  installationId: string
  packageVersion: string
  openFrame: PluginUiFrameOpener
}) {
  const [frame, setFrame] = useState<UserPluginUiFrame | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<
    'PLUGIN_UI_NOT_AVAILABLE' | 'PLUGIN_UI_BUSY' | 'PLUGIN_UI_RATE_LIMITED' | null
  >(null)
  const openGeneration = useRef(0)
  const identity = `${pluginId}\0${installationId}\0${packageVersion}\0${contribution.contributionId}`
  const identityRef = useRef(identity)

  if (identityRef.current !== identity) {
    identityRef.current = identity
    openGeneration.current += 1
  }

  useEffect(() => {
    setFrame(null)
    setLoading(false)
    setFailure(null)
  }, [contribution.contributionId, installationId, packageVersion, pluginId])

  useEffect(() => () => { openGeneration.current += 1 }, [])

  const open = async () => {
    const generation = ++openGeneration.current
    setLoading(true)
    setFailure(null)
    try {
      const result = await openFrame({
        pluginId,
        expectedInstallationId: installationId,
        contributionId: contribution.contributionId,
      })
      if (generation !== openGeneration.current) return
      if (result.ok) {
        setFrame(result.frame)
      }
      else setFailure(result.error)
    } catch {
      if (generation !== openGeneration.current) return
      setFailure('PLUGIN_UI_NOT_AVAILABLE')
    } finally {
      if (generation === openGeneration.current) setLoading(false)
    }
  }

  if (frame) {
    return (
      <iframe
        title={frame.title}
        srcDoc={frame.iframeHtml}
        sandbox=""
        referrerPolicy="no-referrer"
        allow=""
        tabIndex={-1}
        className="w-full rounded-lg border border-kumo-line bg-white"
        style={{height: frame.height}}
      />
    )
  }

  return (
    <div className="rounded-lg border border-dashed border-kumo-line px-4 py-5 text-center">
      <p className="text-[12px] text-kumo-subtle">
        Plugin code runs in a resource-limited Dynamic Worker. Only its validated, inert display
        document reaches this script-free opaque-origin frame.
      </p>
      <WorkshopButton className="mt-3" onClick={open} disabled={loading}>
        <ArrowSquareOut size={13} /> {loading ? 'Opening…' : `Open ${contribution.title}`}
      </WorkshopButton>
      {failure && (
        <p role="alert" className="mt-3 text-[12px] text-kumo-danger">
          {failure === 'PLUGIN_UI_BUSY'
            ? 'Plugin execution is busy. Try again in a moment.'
            : failure === 'PLUGIN_UI_RATE_LIMITED'
              ? 'Plugin execution reached its per-minute limit. Try again shortly.'
              : 'This plugin view is no longer available. Refresh Plugin Center and try again.'}
        </p>
      )}
    </div>
  )
}

/** Selects one of the two closed UI adapters without exposing plugin-provided markup to the host. */
export function PluginUiContributionView({
  contribution,
  pluginId,
  installationId,
  packageVersion,
  openFrame,
}: {
  contribution: UserPluginUiContribution
  pluginId: string
  installationId: string
  packageVersion: string
  openFrame: PluginUiFrameOpener
}) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-base p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-kumo-default">{contribution.title}</h3>
      {contribution.kind === 'declarative' ? (
        <DeclarativePluginUi document={contribution.document} />
      ) : (
        <WorkerRenderedPluginUi
          contribution={contribution}
          pluginId={pluginId}
          installationId={installationId}
          packageVersion={packageVersion}
          openFrame={openFrame}
        />
      )}
    </section>
  )
}
