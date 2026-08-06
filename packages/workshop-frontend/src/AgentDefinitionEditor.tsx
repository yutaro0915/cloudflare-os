import { useEffect, useMemo, useState } from 'react'
import { RpcStub } from 'capnweb'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { AgentDefinition, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'

const EMPTY_DEFINITION = `{
  // Workspace-specific agent settings.
  "version": 1
}`

function definitionText(definition: AgentDefinition | null): string {
  return definition === null ? EMPTY_DEFINITION : JSON.stringify(definition, null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseDefinition(text: string): AgentDefinition {
  let errors: ParseError[] = []
  let value: unknown = parse(text, errors, {allowTrailingComma: true, disallowComments: false})
  if (errors.length > 0) {
    let first = errors[0]
    throw new Error(
      `Invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}.`
    )
  }
  return value as AgentDefinition
}

export default function AgentDefinitionEditor({ overseer }: { overseer: RpcStub<Overseer> }) {
  const [definition, setDefinition] = useState<AgentDefinition | null>(null)
  const [text, setText] = useState(EMPTY_DEFINITION)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotice(null)
    overseer.getAgentDefinition()
      .then(next => {
        if (cancelled) return
        setDefinition(next)
        setText(definitionText(next))
      })
      .catch(err => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [overseer])

  const preview = useMemo(() => {
    if (definition === null) {
      return {
        prompts: 'Default prompt only',
        skills: 'No skill references',
        model: 'Current chat model',
        tools: 'All default tools',
      }
    }

    let enabled = definition.tools?.enabled ?? []
    let disabled = definition.tools?.disabled ?? []
    let tools = enabled.length > 0
      ? `Enabled only: ${enabled.join(', ')}`
      : disabled.length > 0
        ? `Disabled: ${disabled.join(', ')}`
        : 'All default tools'
    return {
      prompts: `${definition.prompts?.length ?? 0} prompt fragment(s)`,
      skills: `${definition.skills?.length ?? 0} skill reference(s)`,
      model: definition.model
        ? `${definition.model.provider} / ${definition.model.model}`
        : 'Current chat model',
      tools,
    }
  }, [definition])

  const save = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      let parsed = parseDefinition(text)
      await overseer.saveAgentDefinition(parsed)
      setDefinition(parsed)
      setNotice('Agent definition saved. It applies when the agent is built again.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await overseer.resetAgentDefinition()
      setDefinition(null)
      setText(EMPTY_DEFINITION)
      setNotice('Agent definition reset to the workspace default.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full overflow-auto bg-kumo-base px-6 py-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <div>
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.35px] text-kumo-default">
            Agent definition
          </h2>
          <p className="mt-1.5 mb-0 max-w-3xl text-[13px] leading-5 text-kumo-subtle">
            Configure ordered prompt fragments, skill references, model metadata, and tool access
            for this workspace. Comments and trailing commas are accepted.
          </p>
        </div>

        <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            <div className="border-b border-kumo-line px-3 py-2 text-[12px] font-medium text-kumo-subtle">
              agent-definition.jsonc
            </div>
            <textarea
              aria-label="Agent definition JSONC"
              value={text}
              onChange={event => setText(event.target.value)}
              disabled={loading || saving}
              spellCheck={false}
              className="min-h-[380px] flex-1 resize-none bg-kumo-base p-4 font-mono text-[13px] leading-5 text-kumo-default outline-none disabled:opacity-60"
            />
          </div>

          <aside className="rounded-xl border border-kumo-line bg-kumo-tint/40 p-4">
            <h3 className="m-0 text-[13px] font-semibold text-kumo-default">Current preview</h3>
            <dl className="mt-4 grid gap-4 text-[12px] leading-[18px]">
              <div>
                <dt className="font-medium text-kumo-subtle">Prompts</dt>
                <dd className="m-0 mt-0.5 break-words text-kumo-default">{preview.prompts}</dd>
              </div>
              <div>
                <dt className="font-medium text-kumo-subtle">Skills</dt>
                <dd className="m-0 mt-0.5 break-words text-kumo-default">{preview.skills}</dd>
              </div>
              <div>
                <dt className="font-medium text-kumo-subtle">Model</dt>
                <dd className="m-0 mt-0.5 break-words text-kumo-default">{preview.model}</dd>
              </div>
              <div>
                <dt className="font-medium text-kumo-subtle">Tools</dt>
                <dd className="m-0 mt-0.5 break-words text-kumo-default">{preview.tools}</dd>
              </div>
            </dl>
          </aside>
        </div>

        {(error || notice) && (
          <p
            role={error ? 'alert' : 'status'}
            className={`m-0 rounded-lg border px-3 py-2 text-[13px] ${
              error
                ? 'border-kumo-danger/30 bg-kumo-danger-tint text-kumo-danger'
                : 'border-kumo-line bg-kumo-tint text-kumo-default'
            }`}
          >
            {error ?? notice}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <WorkshopButton
            tone="secondary"
            onClick={reset}
            disabled={loading || saving || definition === null}
          >
            Reset
          </WorkshopButton>
          <WorkshopButton tone="primary" onClick={save} disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save definition'}
          </WorkshopButton>
        </div>
      </div>
    </div>
  )
}
