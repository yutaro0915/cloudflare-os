import { describe, expect, it } from 'vitest'
import { draftWithToolMode } from './routes/agents'

const draft = {
  id: 'agent-1',
  name: 'Helper',
  modelId: 'model-1',
  agentsMd: '',
  skillIds: [],
  toolMode: 'enabled' as const,
  toolNames: ['readFile', 'writeFile', 'webFetch'],
  bindings: [],
}

describe('draftWithToolMode', () => {
  it('keeps the selection when the active mode is picked again', () => {
    expect(draftWithToolMode(draft, 'enabled')).toBe(draft)
  })

  it('clears the selection when the mode actually changes', () => {
    expect(draftWithToolMode(draft, 'disabled')).toEqual({...draft, toolMode: 'disabled', toolNames: []})
    expect(draftWithToolMode(draft, 'all')).toEqual({...draft, toolMode: 'all', toolNames: []})
  })
})
