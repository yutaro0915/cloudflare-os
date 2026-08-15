// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserPluginUiContribution } from '@gadgets/workshop-shared/api'
import {
  PluginUiContributionView,
  type PluginUiFrameOpener,
} from './PluginUiContributions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PluginUiContributionView', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  async function render(
    contribution: UserPluginUiContribution,
    opener: PluginUiFrameOpener = vi.fn<PluginUiFrameOpener>(),
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <PluginUiContributionView
          contribution={contribution}
          pluginId="example.plugin"
          installationId="installation-1"
          packageVersion="1.0.0"
          openFrame={opener}
        />,
      )
    })
    return opener
  }

  it('renders declarative strings literally through the closed host renderer', async () => {
    await render({
      contributionId: 'details',
      slot: 'user-plugin.details',
      title: 'Details',
      kind: 'declarative',
      document: {
        schemaVersion: 1,
        blocks: [
          {kind: 'text', text: '<script>globalThis.compromised = true</script>'},
          {kind: 'notice', tone: 'warning', text: '<img src=x onerror=alert(1)>'},
          {kind: 'list', items: ['javascript:alert(1)', '<b>literal</b>']},
        ],
      },
    })

    expect(container!.querySelector('script')).toBeNull()
    expect(container!.querySelector('img')).toBeNull()
    expect(container!.querySelector('b')).toBeNull()
    expect(container!.textContent).toContain('<script>globalThis.compromised = true</script>')
    expect(container!.textContent).toContain('<b>literal</b>')
  })

  it('opens worker-rendered UI lazily in an inert opaque-origin frame', async () => {
    const opener = vi.fn<PluginUiFrameOpener>(async () => ({
      ok: true as const,
      frame: {
        title: 'Isolated view',
        iframeHtml: '<!doctype html><title>Isolated</title>',
        height: 320,
      },
    }))
    await render({
      contributionId: 'sandbox',
      slot: 'user-plugin.details',
      title: 'Sandbox',
      kind: 'worker-rendered',
      height: 300,
    }, opener)

    expect(opener).not.toHaveBeenCalled()
    const button = container!.querySelector('button')
    if (!button) throw new Error('Missing open button')
    await act(async () => button.click())

    expect(opener).toHaveBeenCalledWith({
      pluginId: 'example.plugin',
      expectedInstallationId: 'installation-1',
      contributionId: 'sandbox',
    })
    const iframe = container!.querySelector('iframe')
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('allow')).toBe('')
    expect(iframe?.getAttribute('srcdoc')).toContain('<title>Isolated</title>')
  })

  it('does not revive a frame returned for an obsolete installation', async () => {
    let resolveOld: ((result: Awaited<ReturnType<PluginUiFrameOpener>>) => void) | undefined
    const opener = vi.fn<PluginUiFrameOpener>(() => new Promise(resolve => { resolveOld = resolve }))
    const contribution: UserPluginUiContribution = {
      contributionId: 'sandbox',
      slot: 'user-plugin.details',
      title: 'Sandbox',
      kind: 'worker-rendered',
      height: 300,
    }
    await render(contribution, opener)
    const button = container!.querySelector('button')
    if (!button) throw new Error('Missing open button')
    await act(async () => button.click())
    await act(async () => {
      root!.render(
        <PluginUiContributionView
          contribution={contribution}
          pluginId="example.plugin"
          installationId="installation-2"
          packageVersion="2.0.0"
          openFrame={opener}
        />,
      )
    })
    await act(async () => resolveOld!({
      ok: true,
      frame: {
        title: 'Obsolete',
        iframeHtml: '<!doctype html><title>Obsolete</title>',
        height: 320,
      },
    }))

    expect(container!.querySelector('iframe')).toBeNull()
  })
})
