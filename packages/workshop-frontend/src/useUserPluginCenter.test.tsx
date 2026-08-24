// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  InstallUserPluginRequest,
  UserPluginCenterView,
} from '@gadgets/workshop-shared/api'
import {
  type UserPluginCenterApi,
  type UserPluginCenterController,
  useUserPluginCenter,
} from './useUserPluginCenter'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialView: UserPluginCenterView = {
  plugins: [{
    pluginId: 'example.plugin',
    title: 'Example',
    summary: 'Example plugin',
    offers: [{
      packageVersion: '1.0.0',
      title: 'Example',
      summary: 'Example plugin',
      requestedCapabilities: ['plugin.state.read'],
      dependencies: [],
      hasState: true,
      contributions: [],
    }],
    installation: {
      installationId: 'installation-1',
      packageVersion: '1.0.0',
      enabled: true,
      grantedCapabilities: ['plugin.state.read'],
      hasState: true,
      lifecycle: 'installed',
      catalogAvailability: 'available',
      contributions: [],
    },
  }],
  detachedStates: [{
    installationId: 'detached-1',
    pluginId: 'old.plugin',
    packageVersion: '0.9.0',
    detachedAt: 1,
    title: 'Old plugin',
    lifecycle: 'detached',
  }],
}

function Harness({api, onState}: {
  api: UserPluginCenterApi
  onState: (state: UserPluginCenterController) => void
}) {
  const state = useUserPluginCenter(api)
  useEffect(() => onState(state), [onState, state])
  return null
}

describe('useUserPluginCenter', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it('uses exact existing mutations and refreshes the single server-owned view', async () => {
    const api: UserPluginCenterApi = {
      getUserPluginCenter: vi.fn<UserPluginCenterApi['getUserPluginCenter']>(async () => initialView),
      installUserPlugin: vi.fn<UserPluginCenterApi['installUserPlugin']>(async () => ({
        ok: true,
        installationId: 'installation-1',
      })),
      uninstallUserPlugin: vi.fn<UserPluginCenterApi['uninstallUserPlugin']>(async () => ({
        ok: true as const,
        installationId: 'installation-1',
        retainedState: true,
      })),
      purgeUserPluginState: vi.fn<UserPluginCenterApi['purgeUserPluginState']>(async () => ({
        ok: true,
        installationId: 'detached-1',
      })),
      openUserPluginUiFrame: vi.fn<UserPluginCenterApi['openUserPluginUiFrame']>(async () => ({
        ok: false as const,
        error: 'PLUGIN_UI_NOT_AVAILABLE' as const,
      })),
    }
    let latest: UserPluginCenterController | undefined
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <StrictMode><Harness api={api} onState={state => { latest = state }} /></StrictMode>,
    ))
    await act(async () => { await vi.waitFor(() => expect(latest?.view).toEqual(initialView)) })

    // React StrictMode replays the mount effect; both responses remain safe and the second setup
    // must continue accepting state after the first setup's cleanup.
    expect(api.getUserPluginCenter).toHaveBeenCalledTimes(2)
    const request: InstallUserPluginRequest = {
      pluginId: 'example.plugin',
      packageVersion: '1.0.0',
      approvedCapabilities: ['plugin.state.read'],
    }
    await act(async () => { await latest!.install(request) })
    await act(async () => {
      await latest!.uninstall({
        pluginId: 'example.plugin',
        expectedInstallationId: 'installation-1',
      })
    })
    await act(async () => { await latest!.purge({installationId: 'detached-1'}) })

    expect(api.installUserPlugin).toHaveBeenCalledWith(request)
    expect(api.uninstallUserPlugin).toHaveBeenCalledWith({
      pluginId: 'example.plugin',
      expectedInstallationId: 'installation-1',
    })
    expect(api.purgeUserPluginState).toHaveBeenCalledWith({installationId: 'detached-1'})
    expect(api.getUserPluginCenter).toHaveBeenCalledTimes(5)
  })
})
