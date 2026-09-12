// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { applyThemeMode } from './theme'

describe('applyThemeMode', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-mode')
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.removeProperty('color-scheme')
  })

  it('keeps Kumo and Design Token Kit theme selectors synchronized', () => {
    expect(applyThemeMode('dark')).toBe('dark')
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
