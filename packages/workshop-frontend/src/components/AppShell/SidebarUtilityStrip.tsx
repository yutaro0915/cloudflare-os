import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Bug, Desktop, Moon, Plug, Sun } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import BugReportModal, { useBugReportUnread } from '../../BugReportModal'
import { useAuthenticatedApi } from '../../AuthContext'
import { useTheme } from '../../ThemeContext'
import type { ThemeMode } from '../../theme'

const THEME_SEQUENCE: ThemeMode[] = ['system', 'light', 'dark']

function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(mode) + 1) % THEME_SEQUENCE.length]
}

function ThemeModeButton() {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()
  const label = themeMode === 'system'
    ? `Theme: system (${resolvedThemeMode})`
    : `Theme: ${themeMode}`
  const nextMode = nextThemeMode(themeMode)

  return (
    <Tooltip
      content={`${label}. Switch to ${nextMode}.`}
      render={(
        <button
          type="button"
          aria-label={`${label}. Switch to ${nextMode}.`}
          onClick={() => setThemeMode(nextMode)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {themeMode === 'system' ? (
            <Desktop size={15} />
          ) : themeMode === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
        </button>
      )}
    />
  )
}

// Bottom strip on the sidebar: tiny iconography for connections, theme, and the user menu. Mirrors
// the very low-chrome bottom row in the reference design and surfaces Profile / Providers / Admin
// from the user-menu dropdown rather than duplicating them as separate icons.
function StripLink({
  to,
  label,
  children,
}: {
  to: '/gatekeepers'
  label: string
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        {children}
      </Link>
    </Tooltip>
  )
}

function BugReportButton() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [modalOpen, setModalOpen] = useState(false)
  const { unreadCount, clear } = useBugReportUnread(authenticatedApi)

  return (
    <>
      <Tooltip
        content={unreadCount > 0 ? `Report a bug (${unreadCount} updated)` : 'Report a bug'}
        render={(
          <button
            type="button"
            aria-label={unreadCount > 0 ? `Report a bug (${unreadCount} reports updated)` : 'Report a bug'}
            onClick={() => setModalOpen(true)}
            className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
          >
            <Bug size={15} />
            {unreadCount > 0 && (
              <span
                data-testid="bug-report-unread-badge"
                className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-kumo-brand px-0.5 text-[9px] font-semibold leading-none text-kumo-inverse"
              >
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        )}
      />
      <BugReportModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        authenticatedApi={authenticatedApi}
        onReportsSeen={clear}
      />
    </>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 flex items-center gap-1 border-t border-kumo-line bg-kumo-elevated px-3 py-2',
        collapsed ? 'flex-col justify-center gap-2 px-1.5' : '',
      ].join(' ')}
    >
      <StripLink to="/gatekeepers" label="Gatekeepers">
        <Plug size={15} />
      </StripLink>
      <BugReportButton />
      <div className={collapsed ? 'flex flex-col items-center gap-2' : 'ml-auto flex items-center gap-1'}>
        <ThemeModeButton />
        <UserMenu />
      </div>
    </div>
  )
}
