import { useCallback, useEffect, useState } from 'react'
import { Badge, Checkbox, Dialog, Loader, Tabs, Text } from '@cloudflare/kumo'
import { CursorClick } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, MyBugReport, BugReportStatus } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopInputArea } from './components/WorkshopControls'
import { useToasts } from './useToasts'

const MAX_ELEMENT_HTML_CHARS = 4000

interface BugReportModalProps {
  visible: boolean
  onClose: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Called after the "My reports" tab marks reports as seen (so a badge can clear). */
  onReportsSeen?: () => void
}

// Sidebar-badge state: how many of the user's reports changed status since they last opened
// the "My reports" tab. Served from the user DO's stored state (no GitHub traffic).
export function useBugReportUnread(authenticatedApi: RpcStub<AuthenticatedApi>) {
  const [unreadCount, setUnreadCount] = useState(0)
  const refresh = useCallback(() => {
    authenticatedApi.getBugReportUnreadCount().then(setUnreadCount).catch(() => {})
  }, [authenticatedApi])
  useEffect(() => { refresh() }, [refresh])
  return { unreadCount, refresh, clear: () => setUnreadCount(0) }
}

const STATUS_BADGE: Record<BugReportStatus, { label: string; variant: 'neutral' | 'success' | 'warning' | 'error' }> = {
  reported: { label: 'Reported', variant: 'neutral' },
  pr_open: { label: 'PR open', variant: 'warning' },
  merged: { label: 'Fixed', variant: 'success' },
  closed: { label: 'Declined', variant: 'error' },
  unknown: { label: 'Unknown', variant: 'neutral' },
}

// "My reports" tab: the user's own reports with their current progress. Fetches when shown;
// the backend caches GitHub state (~60 s) so re-opens are cheap.
function MyReportsPanel({ authenticatedApi, onSeen }: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  onSeen?: () => void
}) {
  const [reports, setReports] = useState<MyBugReport[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listMyBugReports()
      .then(result => {
        if (cancelled) return
        setReports(result.reports)
        // Opening the list counts as seeing it: reset the unread badge.
        authenticatedApi.markBugReportsSeen().then(() => onSeen?.()).catch(() => {})
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
    // Fetch once per mount (the tab remounts when reselected or the modal reopens).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedApi])

  if (loadError) {
    return (
      <div role="alert" className="py-6 text-center text-[13px] text-kumo-danger">
        Failed to load your reports. Please try again later.
      </div>
    )
  }
  if (reports === null) {
    return <div className="py-8 text-center"><Loader /></div>
  }
  if (reports.length === 0) {
    return (
      <div className="py-8 text-center">
        <Text variant="secondary" size="sm">No bug reports yet.</Text>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="My bug reports">
      {reports.map(report => {
        const badge = STATUS_BADGE[report.status] ?? STATUS_BADGE.unknown
        return (
          <li
            key={report.issueNumber}
            className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2"
          >
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default" title={report.title}>
              {report.title}
            </span>
            <a
              href={report.issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-[12px] text-kumo-brand hover:underline"
            >
              #{report.issueNumber}
            </a>
            {report.pr && (
              <a
                href={report.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[12px] text-kumo-brand hover:underline"
              >
                PR #{report.pr.number}
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}

interface PickedElement {
  selector: string
  html: string
}

// Best-effort CSS selector path for a picked element: id shortcut when available, otherwise
// tag + nth-of-type hops up to the body.
export function cssSelectorPath(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node && node.tagName !== 'HTML' && parts.length < 12) {
    if (node.id) {
      parts.unshift(`#${node.id}`)
      break
    }
    let part = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === node!.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

// Full-page element picker: highlights the hovered element and resolves with the clicked one.
// Rendered outside the dialog so the dialog can hide itself while picking.
function ElementPicker({ onPick, onCancel }: {
  onPick: (picked: PickedElement) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const highlight = document.createElement('div')
    highlight.style.cssText =
      'position:fixed;pointer-events:none;z-index:99998;border:2px solid #f6821f;' +
      'background:rgba(246,130,31,0.12);border-radius:4px;transition:all 60ms ease-out'
    document.body.appendChild(highlight)

    const banner = document.createElement('div')
    banner.textContent = 'Click an element to include it in the report (Esc to cancel)'
    banner.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'background:#1f2023;color:#fff;padding:6px 14px;border-radius:8px;font-size:13px;' +
      'pointer-events:none'
    document.body.appendChild(banner)

    const onMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)
      if (!target || target === highlight || target === banner) return
      const rect = target.getBoundingClientRect()
      highlight.style.left = `${rect.left}px`
      highlight.style.top = `${rect.top}px`
      highlight.style.width = `${rect.width}px`
      highlight.style.height = `${rect.height}px`
    }
    const onClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const target = document.elementFromPoint(event.clientX, event.clientY)
      if (!target || target === highlight || target === banner) {
        onCancel()
        return
      }
      onPick({
        selector: cssSelectorPath(target),
        html: target.outerHTML.slice(0, MAX_ELEMENT_HTML_CHARS),
      })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      highlight.remove()
      banner.remove()
    }
  }, [onPick, onCancel])

  return null
}

export default function BugReportModal({ visible, onClose, authenticatedApi, onReportsSeen }: BugReportModalProps) {
  const toasts = useToasts()
  const [activeTab, setActiveTab] = useState('report')
  const [confirmed, setConfirmed] = useState(false)
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Reset the form each time the modal is opened fresh.
  useEffect(() => {
    if (!visible) {
      setConfirmed(false)
      setDescription('')
      setPicked(null)
      setPicking(false)
      setSubmitting(false)
      setErrorMessage(null)
      setActiveTab('report')
    }
  }, [visible])

  const handlePick = useCallback((element: PickedElement) => {
    setPicked(element)
    setPicking(false)
  }, [])
  const handlePickCancel = useCallback(() => setPicking(false), [])

  const canSubmit = confirmed && description.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const result = await authenticatedApi.submitBugReport({
        description: description.trim(),
        url: window.location.href,
        route: window.location.pathname,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        ...(picked ? { elementHtml: picked.html, elementSelector: picked.selector } : {}),
      })
      toasts.add({ title: `Bug report filed: ${result.issueUrl}`, variant: 'success' })
      onClose()
    } catch (error) {
      console.error('Failed to submit bug report:', error)
      // Show the failure inside the modal too (toasts can be missed): a generic Japanese
      // message, plus the server's reason when it provides one (e.g. not configured /
      // rate limited).
      const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
      setErrorMessage(`バグ報告の送信に失敗しました。時間をおいて再度お試しください。${detail}`)
      toasts.add({ title: 'バグ報告の送信に失敗しました。時間をおいて再度お試しください。', variant: 'error' })
      setSubmitting(false)
    }
  }

  return (
    <>
      {picking && <ElementPicker onPick={handlePick} onCancel={handlePickCancel} />}
      <Dialog.Root
        open={visible && !picking}
        onOpenChange={(open) => { if (!open && !picking) onClose() }}
      >
        <Dialog className="p-6" size="base">
          <Dialog.Title className="text-lg font-semibold mb-2">Report a Bug</Dialog.Title>
          <Text variant="secondary" size="sm">
            Describe what went wrong. Your report is filed as a GitHub issue on the project
            repository.
          </Text>

          <div className="mt-3">
            <Tabs
              variant="underline"
              value={activeTab}
              onValueChange={setActiveTab}
              tabs={[
                { value: 'report', label: 'Report a bug' },
                { value: 'reports', label: 'My reports' },
              ]}
            />
          </div>

          {activeTab === 'reports' && (
            <div className="mt-4">
              <MyReportsPanel authenticatedApi={authenticatedApi} onSeen={onReportsSeen} />
            </div>
          )}

          {activeTab === 'report' && (
          <div className="mt-4 flex flex-col gap-4">
            <WorkshopInputArea
              aria-label="Bug description"
              placeholder="What happened? What did you expect instead?"
              rows={4}
              value={description}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                setDescription(event.target.value)}
            />

            <div className="flex items-center gap-2">
              <WorkshopButton onClick={() => setPicking(true)} disabled={submitting}>
                <CursorClick size={13} weight="bold" />
                {picked ? 'Re-select element' : 'Select element on page'}
              </WorkshopButton>
              {picked && (
                <span className="truncate text-[12px] text-kumo-subtle" title={picked.selector}>
                  {picked.selector}
                </span>
              )}
            </div>

            {picked && (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-kumo-subtle">
                  HTML excerpt below will be included in the public issue:
                </span>
                <pre
                  data-testid="picked-element-preview"
                  className="max-h-28 overflow-auto rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2 text-[11px] leading-[16px] text-kumo-subtle whitespace-pre-wrap break-all"
                >
                  {picked.html}
                </pre>
              </div>
            )}

            <div className="rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2 text-[12px] text-kumo-subtle">
              <div>Included automatically:</div>
              <div className="truncate">URL: {typeof window !== 'undefined' ? window.location.href : ''}</div>
              <div className="truncate">Browser: {typeof navigator !== 'undefined' ? navigator.userAgent : ''}</div>
              <div>
                Viewport: {typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : ''}
              </div>
              <div>
                Everything above — including the URL and any selected element&apos;s HTML — is
                posted to a public GitHub issue.
              </div>
              <div>
                Your display name (which may default to part of your email address) will also
                appear on the issue.
              </div>
            </div>

            <Checkbox
              label="Submit this as a bug report to the public issue tracker"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />

            {errorMessage && (
              <div
                role="alert"
                className="rounded-lg border border-kumo-danger/40 bg-kumo-danger-tint px-3 py-2 text-[12px] text-kumo-danger"
              >
                {errorMessage}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <WorkshopButton onClick={onClose} disabled={submitting}>
                Cancel
              </WorkshopButton>
              <WorkshopButton tone="primary" onClick={handleSubmit} disabled={!canSubmit}>
                {submitting ? 'Submitting...' : 'Submit report'}
              </WorkshopButton>
            </div>
          </div>
          )}
        </Dialog>
      </Dialog.Root>
    </>
  )
}
