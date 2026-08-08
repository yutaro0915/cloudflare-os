import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { BracketsCurly, Wrench } from '@phosphor-icons/react'
import { CUSTOM_AGENT_TOOL_NAMES } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../components/WorkshopControls'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/tools')({ component: ToolsPage })

const TOOL_DESCRIPTIONS: Record<(typeof CUSTOM_AGENT_TOOL_NAMES)[number], string> = {
  readFile: 'Read a file from a workpiece in the active workspace.',
  writeFile: 'Write a file in a workpiece as a proposed change.',
  editFile: 'Apply a targeted edit to a workpiece file.',
  webFetch: 'Fetch a public web resource.',
  observeUserChanges: 'Observe changes made by the user in the workspace.',
  describeBinding: 'Describe an environment binding available to the agent.',
  setGadgetBinding: 'Connect an available resource binding to a Gadget.',
  createGadget: 'Create a Gadget in the active workspace.',
  listBlueprints: 'List available Gadget blueprints.',
  executeCode: 'Execute code against the agent environment.',
  listConnectableResources: 'List resources offered by connected Gatekeepers.',
  requestConnection: 'Request access to a connectable resource.',
  giveUp: 'End a callback task that cannot be completed.',
}

type ToolField = {name: string; type: 'string' | 'boolean'; required: boolean}
type ToolContract = {fields: ToolField[]; example: Record<string, unknown>}

const field = (name: string, type: ToolField['type'], required = true): ToolField =>
  ({name, type, required})

const TOOL_CONTRACTS: Record<(typeof CUSTOM_AGENT_TOOL_NAMES)[number], ToolContract> = {
  readFile: {fields: [field('workpiece', 'string'), field('filename', 'string')], example: {workpiece: 'APP', filename: 'src/index.ts'}},
  writeFile: {fields: [field('workpiece', 'string'), field('filename', 'string'), field('content', 'string')], example: {workpiece: 'APP', filename: 'src/index.ts', content: 'export default {}'}},
  editFile: {fields: [field('workpiece', 'string'), field('filename', 'string'), field('textToReplace', 'string'), field('replacement', 'string')], example: {workpiece: 'APP', filename: 'src/index.ts', textToReplace: 'old', replacement: 'new'}},
  webFetch: {fields: [field('url', 'string'), field('raw', 'boolean', false)], example: {url: 'https://example.com', raw: false}},
  observeUserChanges: {fields: [], example: {}},
  describeBinding: {fields: [field('name', 'string')], example: {name: 'APP'}},
  setGadgetBinding: {fields: [field('gadget', 'string'), field('source', 'string'), field('name', 'string', false)], example: {gadget: 'APP', source: 'DATA'}},
  createGadget: {fields: [field('title', 'string'), field('bindingName', 'string'), field('blueprintId', 'string', false)], example: {title: 'New app', bindingName: 'APP'}},
  listBlueprints: {fields: [], example: {}},
  executeCode: {fields: [field('code', 'string')], example: {code: 'export default async function(self, env, ctx) { return Object.keys(env); }'}},
  listConnectableResources: {fields: [field('vendorId', 'string')], example: {vendorId: 'github'}},
  requestConnection: {fields: [field('vendorId', 'string'), field('resourceUrl', 'string', false), field('reason', 'string'), field('bindingName', 'string')], example: {vendorId: 'github', reason: 'Read the repository', bindingName: 'REPO'}},
  giveUp: {fields: [field('error', 'string')], example: {error: 'The callback cannot be completed.'}},
}

export function validateToolTestInput(
  name: (typeof CUSTOM_AGENT_TOOL_NAMES)[number], input: string,
): string {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Input must be a JSON object.')
  }
  const value = parsed as Record<string, unknown>
  for (const contractField of TOOL_CONTRACTS[name].fields) {
    if (contractField.required && !(contractField.name in value)) {
      throw new Error(`Missing required field: ${contractField.name}`)
    }
    if (contractField.name in value && typeof value[contractField.name] !== contractField.type) {
      throw new Error(`${contractField.name} must be a ${contractField.type}.`)
    }
  }
  return `Valid ${name} input. This checks the runtime input contract without executing side effects.`
}

function ToolsPage() {
  useDocumentTitle('Tools')
  const [selectedName, setSelectedName] = useState<(typeof CUSTOM_AGENT_TOOL_NAMES)[number]>('readFile')
  const [input, setInput] = useState(() => JSON.stringify(TOOL_CONTRACTS.readFile.example, null, 2))
  const [result, setResult] = useState<string | null>(null)
  const tools = useMemo(
    () => CUSTOM_AGENT_TOOL_NAMES.map(name => ({name, description: TOOL_DESCRIPTIONS[name]})),
    [],
  )

  const testInput = () => {
    try {
      setResult(validateToolTestInput(selectedName, input))
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Invalid JSON input.')
    }
  }

  const selected = tools.find(tool => tool.name === selectedName)!
  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-6 sm:px-10">
      <header className="px-3 pb-4 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Tools</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Inspect the backend-registered tools that agents can use.
        </p>
      </header>
      <div className="grid min-h-0 flex-1 gap-5 px-3 pb-10 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-2">
          {tools.map(tool => (
            <button
              key={tool.name}
              type="button"
              onClick={() => {
                setSelectedName(tool.name)
                setInput(JSON.stringify(TOOL_CONTRACTS[tool.name].example, null, 2))
                setResult(null)
              }}
              className={`flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${selectedName === tool.name ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'}`}
            >
              <Wrench size={15} className="mt-0.5 shrink-0 text-kumo-subtle" />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] font-medium text-kumo-default">{tool.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-kumo-subtle">{tool.description}</span>
              </span>
            </button>
          ))}
        </aside>
        <main className="min-h-0 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-6 sm:p-8">
          <div className="flex items-center gap-2">
            <BracketsCurly size={17} className="text-kumo-brand" />
            <h2 className="font-mono text-[14px] font-semibold text-kumo-default">{selected.name}</h2>
          </div>
          <p className="mt-2 text-[13px] leading-5 text-kumo-subtle">{selected.description}</p>
          <section className="mt-8">
            <h3 className="text-[13px] font-semibold text-kumo-default">Input contract</h3>
            {TOOL_CONTRACTS[selectedName].fields.length === 0 ? (
              <p className="mt-2 text-[12px] text-kumo-subtle">This tool takes an empty object.</p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-kumo-line">
                {TOOL_CONTRACTS[selectedName].fields.map(contractField => (
                  <div key={contractField.name} className="grid grid-cols-[1fr_100px_90px] border-b border-kumo-line px-3 py-2 text-[12px] last:border-b-0">
                    <code className="text-kumo-default">{contractField.name}</code>
                    <span className="text-kumo-subtle">{contractField.type}</span>
                    <span className="text-right text-kumo-inactive">{contractField.required ? 'required' : 'optional'}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="mt-8">
            <h3 className="text-[13px] font-semibold text-kumo-default">Test input</h3>
            <p className="mt-1 text-[12px] leading-5 text-kumo-subtle">
              Validate the JSON object against this tool's input contract. Runtime behavior is tested through Agent Preview.
            </p>
            <textarea
              aria-label="Tool test input"
              value={input}
              onChange={event => {
                setInput(event.target.value)
                setResult(null)
              }}
              rows={10}
              spellCheck={false}
              className="mt-3 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-[12px] leading-[19px] text-kumo-default outline-none focus:border-kumo-ring"
            />
            <div className="mt-3 flex justify-end">
              <WorkshopButton onClick={testInput}>Validate contract</WorkshopButton>
            </div>
            {result && (
              <pre className="mt-4 whitespace-pre-wrap rounded-lg border border-kumo-line bg-kumo-tint px-3 py-3 text-[12px] leading-5 text-kumo-subtle">{result}</pre>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}
