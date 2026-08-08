import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { FileMd, Plus, Sparkle, Trash } from '@phosphor-icons/react'
import type { SkillDefinition, SkillMetadata } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { WorkshopButton } from '../components/WorkshopControls'
import { useDocumentTitle } from '../useDocumentTitle'
import { useToasts } from '../useToasts'

export const Route = createFileRoute('/skills')({ component: SkillsPage })

const newSkillMarkdown = (name: string) => `---
name: ${name}
description: Describe what this skill does and when to use it.
---

# ${name}

Add instructions for the agent here.
`

function nextSkillName(skills: SkillDefinition[]): string {
  let names = new Set(skills.map(skill => skill.name))
  if (!names.has('new-skill')) return 'new-skill'
  let index = 2
  while (names.has(`new-skill-${index}`)) index += 1
  return `new-skill-${index}`
}

export function SkillsPage() {
  useDocumentTitle('Skills')
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useToasts()
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [metadata, setMetadata] = useState<SkillMetadata | null>(null)
  // Whether the edit pane is open. Tracked separately from `markdown` and `selectedId`:
  // an empty document is a legitimate editing state (clear, then rewrite), and an
  // unsaved new skill has no id yet.
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listSkillDefinitions().then(list => {
      if (!cancelled) setSkills(list)
    }).catch(error => {
      console.error('Failed to load skills:', error)
      toasts.add({title: 'Failed to load skills', variant: 'error'})
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi, toasts])

  const sortedSkills = useMemo(
    () => skills.toSorted((a, b) => a.name.localeCompare(b.name)),
    [skills],
  )

  const selectSkill = (skill: SkillDefinition) => {
    setSelectedId(skill.id)
    setMarkdown(skill.markdown)
    setMetadata({name: skill.name, description: skill.description})
    setEditing(true)
  }

  const createSkill = () => {
    const name = nextSkillName(skills)
    setSelectedId(null)
    setMarkdown(newSkillMarkdown(name))
    setMetadata({name, description: 'Describe what this skill does and when to use it.'})
    setEditing(true)
  }

  const validateSkill = async () => {
    try {
      const result = await authenticatedApi.validateSkillMarkdown(markdown)
      setMetadata(result)
      toasts.add({title: 'SKILL.md is valid'})
      return result
    } catch (error) {
      console.error('Invalid SKILL.md:', error)
      toasts.add({title: 'Invalid SKILL.md', variant: 'error'})
      return null
    }
  }

  const saveSkill = async () => {
    setSaving(true)
    try {
      const id = selectedId ?? crypto.randomUUID()
      const saved = await authenticatedApi.saveSkillDefinition(id, markdown)
      setSkills(previous => [...previous.filter(skill => skill.id !== saved.id), saved])
      setSelectedId(saved.id)
      setMarkdown(saved.markdown)
      setMetadata({name: saved.name, description: saved.description})
      toasts.add({title: 'Skill saved'})
    } catch (error) {
      console.error('Failed to save skill:', error)
      toasts.add({title: 'Failed to save skill', variant: 'error'})
    } finally {
      setSaving(false)
    }
  }

  const deleteSkill = async () => {
    if (!selectedId || !metadata) return
    if (!confirm(`Delete "${metadata.name}"? This cannot be undone.`)) return
    setSaving(true)
    try {
      await authenticatedApi.deleteSkillDefinition(selectedId)
      setSkills(previous => previous.filter(skill => skill.id !== selectedId))
      setSelectedId(null)
      setMarkdown('')
      setMetadata(null)
      setEditing(false)
      toasts.add({title: 'Skill deleted'})
    } catch (error) {
      console.error('Failed to delete skill:', error)
      toasts.add({title: 'Failed to delete skill', variant: 'error'})
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-4 pt-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Skills</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Store reusable SKILL.md instructions that agents load only when needed.
          </p>
        </div>
        <WorkshopButton tone="primary" onClick={createSkill}>
          <Plus size={14} /> New skill
        </WorkshopButton>
      </header>

      <div className="grid min-h-0 flex-1 gap-5 px-3 pb-10 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-2">
          {loading ? (
            <p className="px-3 py-8 text-center text-[13px] text-kumo-inactive">Loading skills…</p>
          ) : sortedSkills.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Sparkle size={24} className="mx-auto text-kumo-inactive" />
              <p className="mt-3 text-[13px] font-medium text-kumo-default">No skills</p>
            </div>
          ) : sortedSkills.map(skill => (
            <button
              key={skill.id}
              type="button"
              onClick={() => selectSkill(skill)}
              className={`flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${selectedId === skill.id ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'}`}
            >
              <FileMd size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] font-medium text-kumo-default">{skill.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-kumo-subtle">{skill.description}</span>
              </span>
            </button>
          ))}
        </aside>

        <main className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base">
          {!editing ? (
            <div className="flex h-full min-h-[440px] items-center justify-center px-8 text-center">
              <p className="text-[14px] font-medium text-kumo-default">Select a skill or create a new one</p>
            </div>
          ) : (
            <div className="flex min-h-full flex-col p-6 sm:p-8">
              <div className="mb-4">
                <p className="font-mono text-[13px] font-medium text-kumo-default">
                  {metadata?.name ?? 'SKILL.md'} / SKILL.md
                </p>
                <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
                  {metadata?.description ?? 'Validate the document to read its metadata.'}
                </p>
              </div>
              <textarea
                aria-label="SKILL.md"
                value={markdown}
                onChange={event => {
                  setMarkdown(event.target.value)
                  setMetadata(null)
                }}
                spellCheck={false}
                className="min-h-[480px] flex-1 resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-3 font-mono text-[12px] leading-[19px] text-kumo-default outline-none focus:border-kumo-ring"
              />
              <div className="mt-5 flex items-center justify-between border-t border-kumo-line pt-5">
                <div>
                  {selectedId && (
                    <WorkshopButton tone="danger" onClick={deleteSkill} disabled={saving}>
                      <Trash size={13} /> Delete
                    </WorkshopButton>
                  )}
                </div>
                <div className="flex gap-2">
                  <WorkshopButton onClick={validateSkill} disabled={saving}>Validate</WorkshopButton>
                  <WorkshopButton tone="primary" onClick={saveSkill} disabled={saving}>
                    {saving ? 'Saving…' : 'Save skill'}
                  </WorkshopButton>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
