import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { Check, FileMd, Plus, Robot, Trash } from '@phosphor-icons/react'
import {
  CUSTOM_AGENT_TOOL_NAMES,
  type AgentDefinition,
  type AiChatAuthorInfo,
  type SkillDefinition,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentPreview } from '../AgentPreview'
import { WorkshopButton, WorkshopInput } from '../components/WorkshopControls'
import { useDocumentTitle } from '../useDocumentTitle'
import { useToasts } from '../useToasts'

export const Route = createFileRoute('/agents')({ component: AgentsPage })

type ToolMode = 'all' | 'enabled' | 'disabled'

type AgentDraft = {
  id: string
  name: string
  modelId: string
  agentsMd: string
  skillIds: string[]
  toolMode: ToolMode
  toolNames: string[]
}

function newDraft(models: AiChatAuthorInfo[]): AgentDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    modelId: models[0]?.id ?? '',
    agentsMd: '',
    skillIds: [],
    toolMode: 'all',
    toolNames: [],
  }
}

function draftFromDefinition(definition: AgentDefinition): AgentDraft {
  let toolMode: ToolMode = 'all'
  let toolNames: string[] = []
  if (definition.tools?.enabled?.length) {
    toolMode = 'enabled'
    toolNames = definition.tools.enabled
  } else if (definition.tools?.disabled?.length) {
    toolMode = 'disabled'
    toolNames = definition.tools.disabled
  }
  return {...definition, toolMode, toolNames}
}

// Switching modes discards the selection because it means something different per mode;
// re-picking the active mode must stay a no-op so a misclick can't silently drop tools.
export function draftWithToolMode(draft: AgentDraft, mode: ToolMode): AgentDraft {
  if (mode === draft.toolMode) return draft
  return {...draft, toolMode: mode, toolNames: []}
}

function definitionFromDraft(draft: AgentDraft): AgentDefinition {
  let tools: AgentDefinition['tools'] = null
  if (draft.toolMode === 'enabled') tools = {enabled: draft.toolNames}
  if (draft.toolMode === 'disabled') tools = {disabled: draft.toolNames}
  return {
    version: 2,
    id: draft.id,
    name: draft.name.trim(),
    modelId: draft.modelId,
    agentsMd: draft.agentsMd,
    skillIds: draft.skillIds,
    tools,
  }
}

function AgentsPage() {
  useDocumentTitle('Agents')
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useToasts()
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [appliedDefinition, setAppliedDefinition] = useState<AgentDefinition | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      authenticatedApi.listModels(),
      authenticatedApi.listAgentDefinitions(),
      authenticatedApi.listSkillDefinitions(),
    ]).then(([modelList, agentList, skillList]) => {
      if (cancelled) return
      setModels(modelList)
      setAgents(agentList)
      setSkills(skillList)
    }).catch(error => {
      console.error('Failed to load agents:', error)
      toasts.add({title: 'Failed to load agents', variant: 'error'})
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi, toasts])

  const sortedAgents = useMemo(
    () => agents.toSorted((a, b) => a.name.localeCompare(b.name)),
    [agents],
  )

  const selectAgent = (definition: AgentDefinition) => {
    setSelectedId(definition.id)
    setDraft(draftFromDefinition(definition))
    setAppliedDefinition(null)
  }

  const createAgent = () => {
    setSelectedId(null)
    setDraft(newDraft(models))
    setAppliedDefinition(null)
  }

  const saveAgent = async () => {
    if (!draft) return
    const definition = definitionFromDraft(draft)
    if (!definition.name) {
      toasts.add({title: 'Agent name is required', variant: 'error'})
      return
    }
    if (!definition.modelId) {
      toasts.add({title: 'Choose a model', variant: 'error'})
      return
    }
    if (draft.toolMode !== 'all' && draft.toolNames.length === 0) {
      toasts.add({title: 'Select at least one tool', variant: 'error'})
      return
    }
    setSaving(true)
    try {
      await authenticatedApi.saveAgentDefinition(definition)
      setAgents(previous => [
        ...previous.filter(agent => agent.id !== definition.id),
        definition,
      ])
      setSelectedId(definition.id)
      setDraft(draftFromDefinition(definition))
      toasts.add({title: 'Agent saved'})
    } catch (error) {
      console.error('Failed to save agent:', error)
      toasts.add({title: 'Failed to save agent', variant: 'error'})
    } finally {
      setSaving(false)
    }
  }

  const deleteAgent = async () => {
    if (!draft || !selectedId) return
    if (!confirm(`Delete "${draft.name}"? This cannot be undone.`)) return
    setSaving(true)
    try {
      await authenticatedApi.deleteAgentDefinition(selectedId)
      setAgents(previous => previous.filter(agent => agent.id !== selectedId))
      setSelectedId(null)
      setDraft(null)
      toasts.add({title: 'Agent deleted'})
    } catch (error) {
      console.error('Failed to delete agent:', error)
      toasts.add({title: 'Failed to delete agent', variant: 'error'})
    } finally {
      setSaving(false)
    }
  }

  const toggleSkill = (id: string) => {
    setDraft(previous => previous && {
      ...previous,
      skillIds: previous.skillIds.includes(id)
        ? previous.skillIds.filter(skillId => skillId !== id)
        : [...previous.skillIds, id],
    })
  }

  const toggleTool = (name: string) => {
    setDraft(previous => {
      if (!previous) return previous
      const selected = previous.toolNames.includes(name)
      return {
        ...previous,
        toolNames: selected
          ? previous.toolNames.filter(tool => tool !== name)
          : [...previous.toolNames, name],
      }
    })
  }

  const applyToPreview = () => {
    if (!draft) return
    const definition = definitionFromDraft(draft)
    if (!definition.name) {
      toasts.add({title: 'Agent name is required', variant: 'error'})
      return
    }
    if (!definition.modelId) {
      toasts.add({title: 'Choose a model', variant: 'error'})
      return
    }
    if (draft.toolMode !== 'all' && draft.toolNames.length === 0) {
      toasts.add({title: 'Select at least one tool', variant: 'error'})
      return
    }
    setAppliedDefinition({
      ...definition,
      skillIds: [...definition.skillIds],
      tools: definition.tools && {
        ...(definition.tools.enabled ? {enabled: [...definition.tools.enabled]} : {}),
        ...(definition.tools.disabled ? {disabled: [...definition.tools.disabled]} : {}),
      },
    })
    setPreviewRevision(previous => previous + 1)
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[1500px] flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-4 pt-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Agents</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Define reusable agents and choose one when starting a conversation.
          </p>
        </div>
        <WorkshopButton tone="primary" onClick={createAgent} disabled={models.length === 0}>
          <Plus size={14} /> New agent
        </WorkshopButton>
      </header>

      {models.length === 0 && !loading && (
        <div className="mx-3 mb-4 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-[13px] text-kumo-subtle">
          Add an AI model in <Link to="/providers" className="font-medium text-kumo-brand hover:underline">AI providers</Link> before creating an agent.
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-5 px-3 pb-10 xl:grid-cols-[240px_minmax(420px,1.1fr)_minmax(340px,0.9fr)]">
        <aside className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-2">
          {loading ? (
            <p className="px-3 py-8 text-center text-[13px] text-kumo-inactive">Loading agents…</p>
          ) : sortedAgents.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Robot size={24} className="mx-auto text-kumo-inactive" />
              <p className="mt-3 text-[13px] font-medium text-kumo-default">No custom agents</p>
              <p className="mt-1 text-[12px] leading-[18px] text-kumo-subtle">
                Create one to combine a model, AGENTS.md, skills, and tool access.
              </p>
            </div>
          ) : sortedAgents.map(agent => {
            const selected = selectedId === agent.id
            const model = models.find(entry => entry.id === agent.modelId)
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => selectAgent(agent)}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${selected ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
                  <Robot size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-kumo-default">{agent.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-kumo-inactive">
                    {model?.name ?? 'Missing model'}
                  </span>
                </span>
              </button>
            )
          })}
        </aside>

        <main className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base">
          {!draft ? (
            <div className="flex h-full min-h-[440px] items-center justify-center px-8 text-center">
              <div>
                <Robot size={28} className="mx-auto text-kumo-inactive" />
                <p className="mt-3 text-[14px] font-medium text-kumo-default">
                  Select an agent or create a new one
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-7 p-6 sm:p-8">
              <section className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-[12px] font-medium text-kumo-subtle">
                  Name
                  <WorkshopInput
                    value={draft.name}
                    onChange={event => setDraft(previous => previous && {...previous, name: event.target.value})}
                    placeholder="Code reviewer"
                    autoFocus
                  />
                </label>
                <label className="grid gap-1.5 text-[12px] font-medium text-kumo-subtle">
                  Model
                  <select
                    value={draft.modelId}
                    onChange={event => setDraft(previous => previous && {...previous, modelId: event.target.value})}
                    className="h-9 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] text-kumo-default outline-none focus:border-kumo-ring"
                  >
                    {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </select>
                </label>
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <FileMd size={16} className="text-kumo-subtle" />
                  <h2 className="text-[14px] font-semibold text-kumo-default">AGENTS.md</h2>
                </div>
                <p className="mt-1 text-[12px] leading-[18px] text-kumo-subtle">
                  Instructions added to this agent's working context for new conversations.
                </p>
                <textarea
                  aria-label="AGENTS.md"
                  value={draft.agentsMd}
                  onChange={event => setDraft(previous => previous && {...previous, agentsMd: event.target.value})}
                  rows={10}
                  spellCheck={false}
                  className="mt-3 min-h-[220px] w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-[12px] leading-[19px] text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring"
                  placeholder="# Agent instructions\n\nDescribe how this agent should work."
                />
              </section>

              <section>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-[14px] font-semibold text-kumo-default">Skills</h2>
                    <p className="mt-1 text-[12px] leading-[18px] text-kumo-subtle">
                      Select reusable Skills. Their full instructions load only when needed.
                    </p>
                  </div>
                  <Link to="/skills" className="text-[12px] font-medium text-kumo-brand hover:underline">
                    Manage skills
                  </Link>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {skills.length === 0 ? (
                    <div className="col-span-full rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-[12px] text-kumo-inactive">
                      No skills available
                    </div>
                  ) : skills.toSorted((a, b) => a.name.localeCompare(b.name)).map(skill => (
                    <label key={skill.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-kumo-line px-3 py-2.5 hover:bg-kumo-tint">
                      <input
                        type="checkbox"
                        checked={draft.skillIds.includes(skill.id)}
                        onChange={() => toggleSkill(skill.id)}
                        className="mt-0.5 accent-kumo-brand"
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[12px] font-medium text-kumo-default">{skill.name}</span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-kumo-subtle">{skill.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="text-[14px] font-semibold text-kumo-default">Tools</h2>
                <p className="mt-1 text-[12px] leading-[18px] text-kumo-subtle">
                  Use every default tool, allow only selected tools, or block selected tools.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {([
                    ['all', 'All tools'],
                    ['enabled', 'Allow selected'],
                    ['disabled', 'Block selected'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDraft(previous => previous && draftWithToolMode(previous, mode))}
                      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors ${draft.toolMode === mode ? 'border-kumo-brand bg-kumo-brand/10 text-kumo-brand' : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'}`}
                    >
                      {draft.toolMode === mode && <Check size={12} weight="bold" />}
                      {label}
                    </button>
                  ))}
                </div>
                {draft.toolMode !== 'all' && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {CUSTOM_AGENT_TOOL_NAMES.map(name => {
                      const checked = draft.toolNames.includes(name)
                      return (
                        <label key={name} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-kumo-default hover:bg-kumo-tint">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTool(name)}
                            className="accent-kumo-brand"
                          />
                          <span className="font-mono">{name}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>

              <div className="sticky bottom-0 -mx-6 flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-base px-6 py-4 sm:-mx-8 sm:px-8">
                <div>
                  {selectedId && (
                    <WorkshopButton tone="danger" onClick={deleteAgent} disabled={saving}>
                      <Trash size={13} /> Delete
                    </WorkshopButton>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <WorkshopButton onClick={applyToPreview} disabled={saving}>
                    Apply to preview
                  </WorkshopButton>
                  <WorkshopButton tone="primary" onClick={saveAgent} disabled={saving}>
                    {saving ? 'Saving…' : 'Save agent'}
                  </WorkshopButton>
                </div>
              </div>
            </div>
          )}
        </main>

        <aside className="min-h-0">
          {appliedDefinition ? (
            <AgentPreview
              key={previewRevision}
              authenticatedApi={authenticatedApi}
              definition={appliedDefinition}
            />
          ) : (
            <section className="flex min-h-[520px] items-center justify-center rounded-xl border border-kumo-line bg-kumo-base px-8 text-center">
              <div>
                <Robot size={28} className="mx-auto text-kumo-inactive" />
                <p className="mt-3 text-[13px] font-medium text-kumo-default">Preview</p>
                <p className="mt-1 max-w-xs text-[11px] leading-4 text-kumo-subtle">
                  {draft
                    ? 'Apply the current draft to start a temporary conversation. Saving is independent.'
                    : 'Select or create an agent, then apply its draft to start a temporary conversation.'}
                </p>
                {draft && (
                  <WorkshopButton tone="primary" className="mt-4" onClick={applyToPreview}>
                    Apply to preview
                  </WorkshopButton>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
