// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toastAdd = vi.fn<(toast: object) => string>()

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
        open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    },
  )
  return {
    Dialog,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Checkbox: ({ label, checked, onCheckedChange }: {
      label: ReactNode
      checked: boolean
      onCheckedChange: (checked: boolean) => void
    }) => (
      <label>
        <input
          type="checkbox"
          aria-label="confirm-checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        {label}
      </label>
    ),
    Button: ({ children, ...props }: { children: ReactNode }) =>
      <button {...props}>{children}</button>,
    Input: (props: object) => <input {...props} />,
    InputArea: (props: object) => <textarea {...props} />,
    useKumoToastManager: () => ({ add: toastAdd, toasts: [] }),
  }
})

import BugReportModal, { cssSelectorPath } from './BugReportModal'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastAdd.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function makeApi(overrides: Partial<AuthenticatedApi> = {}): RpcStub<AuthenticatedApi> {
  return {
    submitBugReport: vi.fn<() => Promise<{ issueUrl: string }>>().mockResolvedValue({
      issueUrl: 'https://github.com/yutaro0915/cloudflare-os/issues/7',
    }),
    ...overrides,
  } as unknown as RpcStub<AuthenticatedApi>
}

function render(element: ReactElement) {
  act(() => root.render(element))
}

function submitButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find(b => b.textContent?.includes('Submit report'))
  if (!button) throw new Error('submit button not found')
  return button
}

describe('BugReportModal', () => {
  it('disables submit until the checkbox is checked and a description is entered', () => {
    const api = makeApi()
    render(<BugReportModal visible onClose={() => {}} authenticatedApi={api} />)

    expect(submitButton().disabled).toBe(true)

    const textarea = container.querySelector('textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Something broke')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submitButton().disabled).toBe(true)

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })
    expect(submitButton().disabled).toBe(false)
  })

  it('submits the report with page context and toasts the issue URL', async () => {
    const api = makeApi()
    const onClose = vi.fn<() => void>()
    render(<BugReportModal visible onClose={onClose} authenticatedApi={api} />)

    const textarea = container.querySelector('textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Something broke')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await act(async () => { submitButton().click() })

    expect(api.submitBugReport).toHaveBeenCalledTimes(1)
    const report = (api.submitBugReport as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(report.description).toBe('Something broke')
    expect(report.url).toBe(window.location.href)
    expect(report.route).toBe(window.location.pathname)
    expect(report.userAgent).toBe(navigator.userAgent)
    expect(report.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('issues/7'),
      variant: 'success',
    }))
    expect(onClose).toHaveBeenCalled()
  })

  it('discloses that page context and the display name become public', () => {
    render(<BugReportModal visible onClose={() => {}} authenticatedApi={makeApi()} />)
    expect(container.textContent).toContain('posted to a public GitHub issue')
    expect(container.textContent).toContain("selected element's HTML")
    expect(container.textContent).toContain('may default to part of your email address')
  })

  it('shows a Japanese error toast when submission fails', async () => {
    const api = makeApi({
      submitBugReport: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('boom')),
    } as Partial<AuthenticatedApi>)
    render(<BugReportModal visible onClose={() => {}} authenticatedApi={api} />)

    const textarea = container.querySelector('textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Something broke')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await act(async () => { submitButton().click() })

    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
    // The failure must also be visible inside the modal itself, in Japanese, including the
    // server-provided reason (e.g. token not configured / rate limited).
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('バグ報告の送信に失敗しました')
    expect(alert?.textContent).toContain('boom')
  })
})

describe('cssSelectorPath', () => {
  it('uses an id shortcut when available', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div id="app"><section><button>x</button><button>y</button></section></div>'
    document.body.appendChild(host)
    const second = host.querySelectorAll('button')[1]
    expect(cssSelectorPath(second)).toBe('#app > section > button:nth-of-type(2)')
    host.remove()
  })
})
