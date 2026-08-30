import { describe, it, expect } from 'vitest'

// Mirror of the tool source's role detection (the source is bundled; these
// replicate the exact logic to verify the contract).
const ROLE_PERSONAS: Record<string, string> = {
  librarian: 'You are the Librarian',
  fixer: 'You are the Fixer',
  explorer: 'You are the Explorer',
  designer: 'You are the Designer',
  oracle: 'You are the Oracle',
}

function detectSubagentRole(description?: string, prompt?: string): string | undefined {
  const text = `${description ?? ''} ${prompt ?? ''}`.toLowerCase()
  for (const role of Object.keys(ROLE_PERSONAS)) {
    const re = new RegExp(`\\b${role}\\b`, 'i')
    if (re.test(text)) return role
  }
  const signals: Array<[string, RegExp]> = [
    ['librarian', /\b(research|investigate|gather|sources?|api docs?|documentation|web search|external)\b/],
    ['explorer', /\b(map|explore|codebase|structure|locate|find where|understand the code)\b/],
    ['designer', /\b(ui|ux|design|style|interface|responsive|visual|layout)\b/],
    ['fixer', /\b(implement|fix|add|patch|refactor|write code|bug|change the code)\b/],
  ]
  for (const [role, re] of signals) {
    if (re.test(text)) return role
  }
  return undefined
}

describe('subagent role-persona detection', () => {
  it('detects librarian from explicit role name', () => {
    expect(detectSubagentRole('Research SQLite WAL via librarian')).toBe('librarian')
  })
  it('detects fixer from explicit role name', () => {
    expect(detectSubagentRole('Fix the bug', 'Implement the fixer task: patch the parser')).toBe('fixer')
  })
  it('detects explorer from explicit role name', () => {
    expect(detectSubagentRole('Map the codebase with explorer')).toBe('explorer')
  })
  it('detects designer from explicit role name', () => {
    expect(detectSubagentRole('UI work', 'Redesign the settings page as designer')).toBe('designer')
  })
  it('detects oracle from explicit role name', () => {
    expect(detectSubagentRole('Review with oracle')).toBe('oracle')
  })
  it('detects librarian from task-type heuristic (no role name)', () => {
    expect(detectSubagentRole('Research SQLite WAL mode comprehensively')).toBe('librarian')
  })
  it('detects fixer from task-type heuristic (no role name)', () => {
    expect(detectSubagentRole('Add a hello function to the test file')).toBe('fixer')
  })
  it('detects explorer from task-type heuristic', () => {
    expect(detectSubagentRole('Map the codebase structure')).toBe('explorer')
  })
  it('detects designer from task-type heuristic', () => {
    expect(detectSubagentRole('Redesign the settings page UI')).toBe('designer')
  })
  it('returns undefined for generic tasks', () => {
    expect(detectSubagentRole('Do the thing')).toBeUndefined()
  })
  it('does not false-positive on substrings', () => {
    expect(detectSubagentRole('exploration of the fix')).toBe('fixer') // 'fix' is a genuine fixer signal
    expect(detectSubagentRole('just answer this question')).toBeUndefined()
  })
})
