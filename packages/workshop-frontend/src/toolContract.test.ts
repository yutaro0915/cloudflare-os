import { describe, expect, it } from 'vitest'
import { validateToolTestInput } from './routes/tools'

describe('tool input contracts', () => {
  it('accepts a complete runtime input', () => {
    expect(validateToolTestInput(
      'readFile', JSON.stringify({workpiece: 'APP', filename: 'src/index.ts'}),
    )).toContain('Valid readFile input')
  })

  it('rejects missing required fields and wrong primitive types', () => {
    expect(() => validateToolTestInput('readFile', JSON.stringify({workpiece: 'APP'})))
      .toThrow('Missing required field: filename')
    expect(() => validateToolTestInput(
      'webFetch', JSON.stringify({url: 'https://example.com', raw: 'false'}),
    )).toThrow('raw must be a boolean')
  })
})
