// @vitest-environment jsdom

import React, { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserPluginNavigationEntry } from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => {
  const list = vi.fn<() => Promise<UserPluginNavigationEntry[]>>()
  const authenticatedApi = {listUserPluginNavigation: list}
  const auth = {authenticatedApi}
  return {list, authenticatedApi, auth}
})

vi.mock('./AuthContext', () => ({
  useOptionalAuthenticatedApi: () => mocks.auth,
}))

import {
  refreshUserPluginNavigation,
  useUserPluginNavigationModel,
} from './useUserPluginNavigation'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true

function Probe() {
  const navigation = useUserPluginNavigationModel()
  return React.createElement(
    'span',
    null,
    navigation.loading ? 'loading' : navigation.entries.map(entry => entry.title).join(','),
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('useUserPluginNavigationModel', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    mocks.list.mockReset()
  })

  it('adds and removes the sidebar entry after installation lifecycle refreshes in StrictMode', async () => {
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        pluginId: 'circle.personal-kanban',
        installationId: 'installation-1',
        contributionId: 'board',
        title: 'Kanban',
      }])
      .mockResolvedValueOnce([])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      React.createElement(StrictMode, null, React.createElement(Probe)),
    ))
    await flush()
    expect(container.textContent).toBe('')

    await act(async () => refreshUserPluginNavigation(mocks.authenticatedApi))
    await flush()
    expect(container.textContent).toBe('Kanban')

    await act(async () => refreshUserPluginNavigation(mocks.authenticatedApi))
    await flush()
    expect(container.textContent).toBe('')
    expect(mocks.list).toHaveBeenCalledTimes(3)
  })
})
