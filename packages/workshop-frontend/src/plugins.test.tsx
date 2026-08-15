// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  InstallUserPluginRequest,
  InstallUserPluginResult,
  OpenUserPluginUiFrameRequest,
  PurgeUserPluginStateRequest,
  UninstallUserPluginRequest,
  UserPluginCenterView,
} from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => ({
  uninstall: vi.fn<(request: UninstallUserPluginRequest) => Promise<{
    ok: true
    installationId: string
    retainedState: boolean
  }>>(async request => ({
    ok: true,
    installationId: request.expectedInstallationId,
    retainedState: true,
  })),
  purge: vi.fn<(request: PurgeUserPluginStateRequest) => Promise<{
    ok: true
    installationId: string
  }>>(async request => ({ok: true, installationId: request.installationId})),
}))

const pendingView: UserPluginCenterView = {
  plugins: [{
    pluginId: 'example.plugin',
    title: 'Example',
    summary: 'Example plugin',
    offers: [],
    installation: {
      installationId: 'installation-1',
      packageVersion: '1.0.0',
      enabled: false,
      grantedCapabilities: [],
      hasState: true,
      lifecycle: 'uninstalling',
      catalogAvailability: 'available',
      contributions: [],
    },
  }],
  detachedStates: [{
    installationId: 'detached-1',
    pluginId: 'example.plugin',
    packageVersion: '1.0.0',
    detachedAt: 1,
    title: 'Example',
    lifecycle: 'purging',
  }],
}

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({authenticatedApi: {}}),
}))

vi.mock('./useUserPluginCenter', () => ({
  useUserPluginCenter: () => ({
    view: pendingView,
    loading: false,
    error: null,
    mutating: false,
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    install: vi.fn<(
      request: InstallUserPluginRequest,
    ) => Promise<InstallUserPluginResult>>(),
    uninstall: mocks.uninstall,
    purge: mocks.purge,
    openFrame: vi.fn<(request: OpenUserPluginUiFrameRequest) => Promise<{
      ok: false
      error: 'PLUGIN_UI_NOT_AVAILABLE'
    }>>(async () => ({ok: false, error: 'PLUGIN_UI_NOT_AVAILABLE'})),
  }),
}))

import { PluginsPage } from './PluginCenterPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PluginsPage crash recovery actions', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.unstubAllGlobals()
    mocks.uninstall.mockClear()
    mocks.purge.mockClear()
  })

  it('keeps exact uninstall and purge saga retries actionable after reload', async () => {
    vi.stubGlobal('confirm', vi.fn<(message?: string) => boolean>(() => true))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginsPage />))

    expect(container.textContent).toContain('Resume uninstall')
    expect(container.textContent).toContain('Resume purge')
    const buttons = [...container.querySelectorAll('button')]
    const resumeUninstall = buttons.find(button => button.textContent?.includes('Resume uninstall'))
    const resumePurge = buttons.find(button => button.textContent?.includes('Resume purge'))
    expect(resumeUninstall?.disabled).toBe(false)
    expect(resumePurge?.disabled).toBe(false)

    await act(async () => resumeUninstall!.click())
    await act(async () => resumePurge!.click())
    expect(mocks.uninstall).toHaveBeenCalledWith({
      pluginId: 'example.plugin',
      expectedInstallationId: 'installation-1',
    })
    expect(mocks.purge).toHaveBeenCalledWith({installationId: 'detached-1'})
  })
})
