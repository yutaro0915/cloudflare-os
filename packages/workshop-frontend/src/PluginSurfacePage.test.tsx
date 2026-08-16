// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  InteractUserPluginSurfaceRequest,
  InteractUserPluginSurfaceResult,
} from '@gadgets/workshop-shared/api'

const emptyDocument = {
  schemaVersion: 1 as const,
  title: 'Editorial Workflow',
  form: {actionId: 'item.create', label: 'Add note', placeholder: 'Note', maxLength: 200},
  columns: [
    {columnId: 'draft', title: 'Draft', items: []},
    {columnId: 'review', title: 'Review', items: []},
  ],
}

const mocks = vi.hoisted(() => {
  const interact = vi.fn<(request: InteractUserPluginSurfaceRequest) =>
    Promise<InteractUserPluginSurfaceResult>>()
  return {
    interact,
    authenticatedApi: {interactUserPluginSurface: interact},
    navigation: {
      loading: false,
      entries: [{
        pluginId: 'circle.personal-kanban',
        installationId: 'installation-1',
        packageVersion: '1.0.0',
        contributionId: 'board',
        title: 'Kanban',
      }],
    },
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: mocks.authenticatedApi,
  }),
}))

vi.mock('./useUserPluginNavigation', () => ({
  useUserPluginNavigationModel: () => mocks.navigation,
}))

vi.mock('./useDocumentTitle', () => ({useDocumentTitle: vi.fn<() => void>()}))

import { PluginSurfacePage } from './PluginSurfacePage'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('PluginSurfacePage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    mocks.interact.mockReset()
    mocks.navigation.loading = false
    mocks.navigation.entries = [{
      pluginId: 'circle.personal-kanban',
      installationId: 'installation-1',
      packageVersion: '1.0.0',
      contributionId: 'board',
      title: 'Kanban',
    }]
  })

  it('renders the generic columns and forwards create and move actions to the plugin reducer', async () => {
    mocks.interact.mockImplementation(async request => {
      if (request.interaction.kind === 'open') {
        return {ok: true, revision: 0, document: emptyDocument}
      }
      if (request.interaction.actionId === 'item.create') {
        return {
          ok: true,
          revision: 1,
          document: {
            ...emptyDocument,
            columns: [{
              ...emptyDocument.columns[0],
              items: [{
                itemId: 'task-1',
                title: request.interaction.input!,
                actions: [{
                  actionId: 'item.publish:task-1',
                  label: 'Send to review',
                  tone: 'neutral',
                }],
              }],
            }, emptyDocument.columns[1]],
          },
        }
      }
      if (request.interaction.actionId === 'item.delete:task-1') {
        return {ok: true, revision: 3, document: emptyDocument}
      }
      return {
        ok: true,
        revision: 2,
        document: {
          ...emptyDocument,
          columns: [emptyDocument.columns[0], {
            ...emptyDocument.columns[1],
            items: [{
              itemId: 'task-1',
              title: 'Write the demo',
              actions: [{
                actionId: 'item.delete:task-1',
                label: 'Delete',
                tone: 'danger',
              }],
            }],
          }],
        },
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    })))
    await flush()

    expect(container.textContent).toContain('Editorial Workflow')
    expect(container.textContent).toContain('Draft')
    const input = container.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'Write the demo')
      input.dispatchEvent(new Event('input', {bubbles: true}))
    })
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(
        new Event('submit', {bubbles: true, cancelable: true}),
      )
    })
    await flush()

    expect(mocks.interact).toHaveBeenCalledWith(expect.objectContaining({
      interaction: expect.objectContaining({
        kind: 'action',
        expectedRevision: 0,
        actionId: 'item.create',
        input: 'Write the demo',
      }),
    }))
    expect(container.textContent).toContain('Write the demo')

    const move = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Send to review')!
    await act(async () => move.click())
    await flush()
    expect(mocks.interact).toHaveBeenLastCalledWith(expect.objectContaining({
      interaction: expect.objectContaining({
        expectedRevision: 1,
        actionId: 'item.publish:task-1',
      }),
    }))
    expect(container.textContent).toContain('revision 2')

    const remove = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Delete')!
    await act(async () => remove.click())
    await flush()
    expect(mocks.interact).toHaveBeenLastCalledWith(expect.objectContaining({
      interaction: expect.objectContaining({
        expectedRevision: 2,
        actionId: 'item.delete:task-1',
      }),
    }))
    expect(container.textContent).toContain('revision 3')
    expect(container.textContent).not.toContain('Write the demo')
  })

  it('retries a committed action with the same mutation ID after its response is lost', async () => {
    let committedMutationId: string | undefined
    let appliedCount = 0
    mocks.interact.mockImplementation(async request => {
      if (request.interaction.kind === 'open') {
        return {ok: true, revision: 0, document: emptyDocument}
      }
      if (committedMutationId === undefined) {
        committedMutationId = request.interaction.mutationId
        appliedCount += 1
        throw new Error('response lost after commit')
      }
      if (request.interaction.mutationId !== committedMutationId) appliedCount += 1
      return {
        ok: true,
        revision: 1,
        document: {
          ...emptyDocument,
          columns: [{
            ...emptyDocument.columns[0],
            items: [{
              itemId: 'task-1',
              title: request.interaction.input!,
              actions: [],
            }],
          }, emptyDocument.columns[1]],
        },
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    })))
    await flush()

    const input = container.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'Keep this task')
      input.dispatchEvent(new Event('input', {bubbles: true}))
      container!.querySelector('form')!.dispatchEvent(
        new Event('submit', {bubbles: true, cancelable: true}),
      )
    })
    await flush()

    expect(container.textContent).toContain('The plugin action failed.')
    expect(input.value).toBe('Keep this task')
    expect(input.disabled).toBe(true)
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true)
    const retry = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Retry action')!
    expect(container.textContent).toContain('Reload latest')
    await act(async () => retry.click())
    await flush()

    const actionRequests = mocks.interact.mock.calls
      .map(([request]) => request)
      .filter(request => request.interaction.kind === 'action')
    expect(actionRequests).toHaveLength(2)
    expect(actionRequests[1]).toEqual(actionRequests[0])
    expect(actionRequests[1]!.interaction).toMatchObject({mutationId: committedMutationId})
    expect(appliedCount).toBe(1)
    expect(container.textContent?.match(/Keep this task/g)).toHaveLength(1)
    expect(container.textContent).toContain('revision 1')
    expect(container.textContent).not.toContain('Retry action')
    expect(input.value).toBe('')
  })

  it('discards an uncertain action only by reloading the latest owner state', async () => {
    let openCount = 0
    let actionCount = 0
    mocks.interact.mockImplementation(async request => {
      if (request.interaction.kind === 'action') {
        actionCount += 1
        throw new Error('response lost after commit')
      }
      openCount += 1
      if (openCount === 1) return {ok: true, revision: 0, document: emptyDocument}
      return {
        ok: true,
        revision: 1,
        document: {
          ...emptyDocument,
          columns: [{
            ...emptyDocument.columns[0],
            items: [{itemId: 'task-1', title: 'Loaded from owner state', actions: []}],
          }, emptyDocument.columns[1]],
        },
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    })))
    await flush()

    const input = container.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'Loaded from owner state')
      input.dispatchEvent(new Event('input', {bubbles: true}))
      container!.querySelector('form')!.dispatchEvent(
        new Event('submit', {bubbles: true, cancelable: true}),
      )
    })
    await flush()

    const reload = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Reload latest')!
    await act(async () => reload.click())
    await flush()

    expect(actionCount).toBe(1)
    expect(openCount).toBe(2)
    expect(container.textContent).toContain('Loaded from owner state')
    expect(container.textContent).toContain('revision 1')
    expect(container.textContent).not.toContain('Retry action')
  })

  it('keeps an uncertain action when navigation refreshes the same surface', async () => {
    let rejectAction!: (reason: Error) => void
    const actionResponse = new Promise<InteractUserPluginSurfaceResult>((_resolve, reject) => {
      rejectAction = reject
    })
    mocks.interact.mockImplementation(async request => request.interaction.kind === 'open'
      ? {ok: true, revision: 0, document: emptyDocument}
      : actionResponse)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    }))
    await act(async () => render())
    await flush()

    const input = container.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'Survive navigation refresh')
      input.dispatchEvent(new Event('input', {bubbles: true}))
      container!.querySelector('form')!.dispatchEvent(
        new Event('submit', {bubbles: true, cancelable: true}),
      )
    })

    mocks.navigation.loading = true
    mocks.navigation.entries = [...mocks.navigation.entries]
    await act(async () => render())
    rejectAction(new Error('response lost after commit'))
    await flush()

    expect(input.value).toBe('Survive navigation refresh')
    expect(container.textContent).toContain('The plugin action failed.')
    expect(container.textContent).toContain('Retry action')
    expect(container.textContent).toContain('Reload latest')
  })

  it('fences a pending action from a replacement package and opens the new version', async () => {
    const actionRequests: InteractUserPluginSurfaceRequest[] = []
    mocks.interact.mockImplementation(async request => {
      if (request.interaction.kind === 'action') {
        actionRequests.push(structuredClone(request))
        if (actionRequests.length === 1) throw new Error('response lost after commit')
        return {ok: false, error: 'PLUGIN_UI_NOT_AVAILABLE'}
      }
      return request.expectedPackageVersion === '1.0.0'
        ? {ok: true, revision: 0, document: {...emptyDocument, title: 'Version one'}}
        : {ok: true, revision: 1, document: {...emptyDocument, title: 'Version two'}}
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    }))
    await act(async () => render())
    await flush()

    const input = container.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'Old reducer action')
      input.dispatchEvent(new Event('input', {bubbles: true}))
      container!.querySelector('form')!.dispatchEvent(
        new Event('submit', {bubbles: true, cancelable: true}),
      )
    })
    await flush()
    expect(container.textContent).toContain('Retry action')

    mocks.navigation.entries = [{...mocks.navigation.entries[0]!, packageVersion: '2.0.0'}]
    await act(async () => render())
    const retry = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Retry action')!
    await act(async () => retry.click())
    await flush()

    expect(actionRequests).toHaveLength(2)
    expect(actionRequests[1]).toEqual(actionRequests[0])
    expect(actionRequests[1]).toMatchObject({expectedPackageVersion: '1.0.0'})
    expect(container.textContent).toContain('Version two')
    expect(container.textContent).toContain('revision 1')
    expect(container.textContent).not.toContain('Retry action')
  })

  it('ignores a late refresh from an uninstalled lifecycle and opens the replacement', async () => {
    let resolveOldRefresh!: (result: InteractUserPluginSurfaceResult) => void
    const oldRefresh = new Promise<InteractUserPluginSurfaceResult>(resolve => {
      resolveOldRefresh = resolve
    })
    let openCount = 0
    mocks.interact.mockImplementation(async request => {
      openCount += 1
      if (openCount === 1) {
        return {ok: true, revision: 1, document: {...emptyDocument, title: 'Old lifecycle'}}
      }
      if (openCount === 2) return oldRefresh
      expect(request.expectedInstallationId).toBe('installation-2')
      return {ok: true, revision: 0, document: {...emptyDocument, title: 'New lifecycle'}}
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    })))
    await flush()
    expect(container.textContent).toContain('Old lifecycle')

    const refresh = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Refresh'))!
    await act(async () => refresh.click())
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true)

    mocks.navigation.entries = [{
      pluginId: 'circle.personal-kanban',
      installationId: 'installation-2',
      packageVersion: '1.0.0',
      contributionId: 'board',
      title: 'Kanban',
    }]
    await act(async () => root!.render(React.createElement(PluginSurfacePage, {
      pluginId: 'circle.personal-kanban',
      contributionId: 'board',
    })))
    await flush()
    expect(container.textContent).toContain('New lifecycle')

    resolveOldRefresh({
      ok: true,
      revision: 99,
      document: {...emptyDocument, title: 'Stale old lifecycle'},
    })
    await flush()
    expect(container.textContent).toContain('New lifecycle')
    expect(container.textContent).not.toContain('Stale old lifecycle')
  })
})
