import { useCallback, useEffect, useState } from 'react'
import { Checkbox, Dialog, Text } from '@cloudflare/kumo'
import { CursorClick } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopInputArea } from './components/WorkshopControls'
import { useToasts } from './useToasts'

const MAX_ELEMENT_HTML_CHARS = 4000

interface BugReportModalProps {
  visible: boolean
  onClose: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
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

export default function BugReportModal({ visible, onClose, authenticatedApi }: BugReportModalProps) {
  const toasts = useToasts()
  const [confirmed, setConfirmed] = useState(false)
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset the form each time the modal is opened fresh.
  useEffect(() => {
    if (!visible) {
      setConfirmed(false)
      setDescription('')
      setPicked(null)
      setPicking(false)
      setSubmitting(false)
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

            <div className="rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2 text-[12px] text-kumo-subtle">
              <div>Included automatically:</div>
              <div className="truncate">URL: {typeof window !== 'undefined' ? window.location.href : ''}</div>
              <div className="truncate">Browser: {typeof navigator !== 'undefined' ? navigator.userAgent : ''}</div>
              <div>
                Viewport: {typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : ''}
              </div>
            </div>

            <Checkbox
              label="Submit this as a bug report to the public issue tracker"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />

            <div className="flex justify-end gap-2">
              <WorkshopButton onClick={onClose} disabled={submitting}>
                Cancel
              </WorkshopButton>
              <WorkshopButton tone="primary" onClick={handleSubmit} disabled={!canSubmit}>
                {submitting ? 'Submitting...' : 'Submit report'}
              </WorkshopButton>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}
