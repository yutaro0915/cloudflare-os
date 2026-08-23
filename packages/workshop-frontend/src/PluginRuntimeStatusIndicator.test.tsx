// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {Overseer, PluginRuntimeStatusView} from '@gadgets/workshop-shared/api'
import type {RpcStub} from 'capnweb'
import PluginRuntimeStatusIndicator from './PluginRuntimeStatusIndicator'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('PluginRuntimeStatusIndicator', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it('shows failed and active reconciler states without authority fields', async () => {
    const getPluginRuntimeStatus = vi.fn<() => Promise<PluginRuntimeStatusView>>(async () => ({
      outcome: 'ready' as const,
      observedAt: 1,
      states: [{
        pluginId: 'example.active',
        status: 'active' as const,
        active: {
          installationId: 'installation-a',
          pluginId: 'example.active',
          packageVersion: '1.0.0',
          manifestDigest: `sha256:${'a'.repeat(64)}`,
        },
      }, {
        pluginId: 'example.failed',
        status: 'failed' as const,
        reason: 'ACTIVATION_FAILED' as const,
      }],
    }))
    const overseer = {getPluginRuntimeStatus} as unknown as RpcStub<Overseer>
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginRuntimeStatusIndicator overseer={overseer} />))
    await flush()

    expect(container.textContent).toContain('1 plugin failed')
    await act(async () => container!.querySelector('button')!.click())
    expect(container.textContent).toContain('example.active')
    expect(container.textContent).toContain('example.failed')
    expect(container.textContent).toContain('activation failed')
    expect(container.textContent).not.toContain('sha256:')
  })

  it('surfaces a status read failure as unavailable', async () => {
    const overseer = {
      getPluginRuntimeStatus: vi.fn<() => Promise<PluginRuntimeStatusView>>(
        async () => { throw new Error('offline') },
      ),
    } as unknown as RpcStub<Overseer>
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginRuntimeStatusIndicator overseer={overseer} />))
    await flush()

    expect(container.textContent).toContain('Plugin runtime unavailable')
  })
})
