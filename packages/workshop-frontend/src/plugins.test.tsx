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
  view: undefined as UserPluginCenterView | undefined,
  install: vi.fn<(request: InstallUserPluginRequest) => Promise<InstallUserPluginResult>>(async () => ({
    ok: true,
    installationId: 'imported-installation',
  })),
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

const reviewView: UserPluginCenterView = {
  plugins: [{
    pluginId: 'community.available-board',
    title: 'Available Board',
    summary: 'Published by another user.',
    offers: [{
      packageVersion: '1.2.3',
      title: 'Available Board',
      summary: 'Published by another user.',
      requestedCapabilities: ['plugin.ui.state.mutate'],
      dependencies: [],
      hasState: true,
      contributions: [],
    }],
    installation: null,
  }, {
    pluginId: 'community.installed-board',
    title: 'Installed Board',
    summary: 'Stateful installed plugin.',
    offers: [],
    installation: {
      installationId: 'installed-lifecycle',
      packageVersion: '2.0.0',
      enabled: true,
      grantedCapabilities: ['plugin.ui.state.mutate'],
      hasState: true,
      lifecycle: 'installed',
      catalogAvailability: 'available',
      contributions: [],
    },
  }],
  detachedStates: [{
    installationId: 'detached-lifecycle',
    pluginId: 'community.detached-board',
    packageVersion: '1.0.0',
    detachedAt: 1,
    title: 'Detached Board',
    lifecycle: 'detached',
  }],
}

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({authenticatedApi: {}}),
}))

vi.mock('./useUserPluginCenter', () => ({
  useUserPluginCenter: () => ({
    view: mocks.view ?? pendingView,
    loading: false,
    error: null,
    mutating: false,
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    install: mocks.install,
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
    mocks.view = undefined
    mocks.install.mockClear()
    mocks.uninstall.mockClear()
    mocks.purge.mockClear()
  })

  it('keeps exact uninstall and purge saga retries actionable after reload', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginsPage />))

    expect(container.textContent).toContain('Plugin Store')
    expect(container.textContent).toContain('Publication authority is locked')

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

  it('keeps import, uninstall, and permanent purge consequences visible before mutation', async () => {
    mocks.view = reviewView
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginsPage />))

    const buttons = () => [...container!.querySelectorAll('button')]
    await act(async () => buttons().find(button => button.textContent?.trim() === 'Import')!.click())
    expect(container.textContent).toContain('Review exact package before import')
    expect(container.textContent).toContain('plugin.ui.state.mutate')
    expect(container.textContent).toContain('State is retained until a separate purge.')
    await act(async () => buttons().find(button => button.textContent?.includes('Approve capabilities'))!.click())
    expect(mocks.install).toHaveBeenCalledWith({
      pluginId: 'community.available-board',
      packageVersion: '1.2.3',
      approvedCapabilities: ['plugin.ui.state.mutate'],
    })

    await act(async () => buttons().find(button => button.textContent?.trim() === 'Uninstall')!.click())
    expect(container.textContent).toContain('Review uninstall')
    expect(container.textContent).toContain('It is not deleted by uninstall.')
    await act(async () => buttons().find(button => button.textContent?.includes('Uninstall and retain'))!.click())
    expect(mocks.uninstall).toHaveBeenCalledWith({
      pluginId: 'community.installed-board',
      expectedInstallationId: 'installed-lifecycle',
    })

    await act(async () => buttons().find(button => button.textContent?.trim() === 'Purge data')!.click())
    expect(container.textContent).toContain('Permanently delete retained plugin data')
    expect(container.textContent).toContain('separate from uninstall and cannot be undone')
    await act(async () => buttons().find(button => button.textContent?.includes('Permanently purge'))!.click())
    expect(mocks.purge).toHaveBeenCalledWith({installationId: 'detached-lifecycle'})
  })
})
