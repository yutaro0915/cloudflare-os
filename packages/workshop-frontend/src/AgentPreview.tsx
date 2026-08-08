import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { PaperPlaneRight, Robot, Stop } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AgentDefinition,
  AiChatMessage,
  AuthenticatedApi,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'

type AgentPreviewProps = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  definition: AgentDefinition
}

export function AgentPreview({authenticatedApi, definition}: AgentPreviewProps) {
  const [previewState, setPreviewState] = useState<{overseer: RpcStub<Overseer>} | null>(null)
  const [chatId, setChatId] = useState<number | null>(null)
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [opening, setOpening] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const overseer = previewState?.overseer ?? null

  useEffect(() => {
    mounted.current = true
    let preview: RpcStub<Overseer> | null = null
    authenticatedApi.openAgentPreview().then(result => {
      preview = result
      if (mounted.current) setPreviewState({overseer: result})
    }).catch(reason => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (mounted.current) setOpening(false)
    })
    return () => {
      mounted.current = false
      const disposable = preview as (RpcStub<Overseer> & {[Symbol.dispose]?: () => void}) | null
      disposable?.[Symbol.dispose]?.()
    }
  }, [authenticatedApi])

  const refresh = useCallback(async () => {
    if (!overseer || chatId === null) return
    try {
      const [history, chats] = await Promise.all([
        overseer.getChatHistory(chatId),
        overseer.listChats(),
      ])
      if (!mounted.current) return
      setMessages(history.messages)
      setRunning(Boolean(chats.find(chat => chat.id === chatId)?.activeAgent))
    } catch (reason) {
      if (mounted.current) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(`Failed to refresh preview: ${message}`)
      }
    }
  }, [chatId, overseer])

  useEffect(() => {
    if (chatId === null) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 750)
    return () => window.clearInterval(timer)
  }, [chatId, refresh])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = input.trim()
    if (!message || !overseer || running) return
    setInput('')
    setError(null)
    setRunning(true)
    try {
      if (chatId === null) {
        const id = await authenticatedApi.startAgentPreviewChat(message, definition)
        if (mounted.current) setChatId(id)
      } else {
        await overseer.sendChatMessage(chatId, message, definition.modelId)
        await refresh()
      }
    } catch (reason) {
      if (mounted.current) {
        setRunning(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }

  const stop = async () => {
    if (!overseer || chatId === null) return
    await overseer.stopAgent(chatId)
    await refresh()
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <section className="flex min-h-[520px] flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
            <Robot size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-kumo-default">Preview</h2>
            <p className="truncate text-[11px] text-kumo-inactive">{definition.name || 'Unsaved agent'}</p>
          </div>
        </div>
        {running && chatId !== null && (
          <WorkshopButton onClick={() => void stop()}>
            <Stop size={12} weight="fill" /> Stop
          </WorkshopButton>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {messages.length === 0 && !error && (
          <div className="flex h-full min-h-[260px] items-center justify-center text-center">
            <div>
              <Robot size={28} className="mx-auto text-kumo-inactive" />
              <p className="mt-3 text-[13px] font-medium text-kumo-default">
                {opening ? 'Opening preview…' : 'Start a conversation'}
              </p>
              <p className="mt-1 max-w-xs text-[11px] leading-4 text-kumo-subtle">
                This conversation uses the applied draft without saving the Agent.
              </p>
            </div>
          </div>
        )}
        {messages.map(message => {
          if (message.type === 'error') {
            return <div key={message.sequence} className="rounded-lg bg-kumo-danger/10 px-3 py-2 text-[12px] text-kumo-danger">{message.message}</div>
          }
          if (message.type !== 'message') return null
          const fromAgent = message.author.type === 'agent'
          return (
            <article key={message.sequence} className={`flex ${fromAgent ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[88%] rounded-xl px-3 py-2 ${fromAgent ? 'bg-kumo-tint text-kumo-default' : 'bg-kumo-brand text-white'}`}>
                <p className="whitespace-pre-wrap text-[12px] leading-[18px]">{message.message}</p>
                {message.toolCalls?.map(call => (
                  <details key={call.toolCallId} className="mt-2 rounded border border-current/15 px-2 py-1 text-[11px]">
                    <summary className="cursor-pointer font-mono">{call.toolName}{call.error ? ' · failed' : ''}</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono">{JSON.stringify(call.input, null, 2)}</pre>
                    {call.error && <p className="mt-1">{call.error}</p>}
                  </details>
                ))}
              </div>
            </article>
          )
        })}
        {running && <p className="text-[11px] text-kumo-inactive">Agent is responding…</p>}
        {error && <div role="alert" className="rounded-lg bg-kumo-danger/10 px-3 py-2 text-[12px] text-kumo-danger">{error}</div>}
      </div>

      <form onSubmit={submit} className="border-t border-kumo-line p-3">
        <div className="flex items-end gap-2 rounded-xl border border-kumo-line bg-kumo-tint p-2 focus-within:border-kumo-ring">
          <textarea
            aria-label="Preview message"
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={2}
            disabled={!overseer || running}
            placeholder="Message this agent…"
            className="min-h-10 flex-1 resize-none bg-transparent px-1 py-1 text-[12px] leading-[18px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
          <button
            type="submit"
            aria-label="Send preview message"
            disabled={!overseer || running || !input.trim()}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-kumo-brand text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PaperPlaneRight size={14} weight="fill" />
          </button>
        </div>
      </form>
    </section>
  )
}
