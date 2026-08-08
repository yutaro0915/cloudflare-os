// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDefinition } from '@gadgets/workshop-shared/api'

const SKILL: SkillDefinition = {
  id: 'skill-1',
  name: 'daily-brief',
  description: 'Summarise the day.',
  markdown: '---\nname: daily-brief\n---\n\n# daily-brief\n',
} as SkillDefinition

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  listSkillDefinitions: vi.fn<() => Promise<unknown[]>>(),
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: { listSkillDefinitions: testState.listSkillDefinitions },
  }),
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import { SkillsPage } from './routes/skills'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Skills editor pane', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  const textarea = () => container!.querySelector<HTMLTextAreaElement>('[aria-label="SKILL.md"]')

  it('keeps the textarea mounted after the document is emptied', async () => {
    testState.listSkillDefinitions.mockResolvedValue([SKILL])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SkillsPage />))

    const skillButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('daily-brief'))
    expect(skillButton).toBeDefined()
    await act(async () => skillButton!.click())
    expect(textarea()?.value).toBe(SKILL.markdown)

    // React tracks the last value it saw; assigning `.value` directly updates that
    // tracker too, so the change event would be swallowed. Go through the prototype setter.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const field = textarea()!
    await act(async () => {
      setValue.call(field, '')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(textarea()).not.toBeNull()
    expect(textarea()!.value).toBe('')
    expect(container.textContent).not.toContain('Select a skill or create a new one')
  })

  it('shows the placeholder until a skill is selected', async () => {
    testState.listSkillDefinitions.mockResolvedValue([SKILL])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SkillsPage />))

    expect(textarea()).toBeNull()
    expect(container.textContent).toContain('Select a skill or create a new one')
  })
})
