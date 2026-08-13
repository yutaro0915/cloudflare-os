// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import OnboardingWizard from './OnboardingWizard'
import { useAuthenticatedApi } from './AuthContext'

vi.mock('./AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }));
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }));
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }));
vi.mock('./useToasts', () => ({ useToasts: () => ({ add: vi.fn<() => string>() }) }));
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: vi.fn<(title: string) => void>() }));
vi.mock('./AddModelModal', () => ({ default: () => null }));
vi.mock('./components/SiteLogo', () => ({ default: ({ children }: { children: unknown }) => children }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const authenticatedApi = {
  listModels: vi.fn<AuthenticatedApi['listModels']>(async () => []),
  getAiConfig: vi.fn<AuthenticatedApi['getAiConfig']>(async () => ({ enabled: false })),
  listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>(async () => []),
  subscribeConnectedAccounts: vi.fn<
    (subscriber: RpcStub<ConnectedAccountsSubscriber>) => Promise<{ [Symbol.dispose](): void }>
  >(
    async () => ({ [Symbol.dispose]: vi.fn<() => void>() }),
  ),
} as unknown as RpcStub<AuthenticatedApi>

describe('OnboardingWizard', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  it('shows the remote build note on the first onboarding screen', async () => {
    vi.mocked(useAuthenticatedApi).mockReturnValue({
      authenticatedApi,
      currentUser: { type: 'user', id: 'user-1', name: 'Test User' },
      isAdmin: false,
      logout: vi.fn<() => void>(),
    } as ReturnType<typeof useAuthenticatedApi>)

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<OnboardingWizard onComplete={vi.fn<() => void>()} />))

    expect(container.textContent).toContain('Just a few things before you start building')
    expect(container.textContent).toContain('Built remotely on case')
  })
})
