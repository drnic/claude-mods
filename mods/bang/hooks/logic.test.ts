import { describe, expect, test } from 'claude-code/testing'

import { bangCommand, formatResult, lastSuggestion } from './logic'

describe('bang logic', () => {
  test('reads a ! prompt', async () => {
    expect(bangCommand('! git status')).toBe('git status')
    expect(bangCommand('!ls -la')).toBe('ls -la')
    expect(bangCommand('what does ! do')).toBe(undefined)
    expect(bangCommand('!')).toBe(undefined)
  })

  test('finds the last suggested command', async () => {
    expect(lastSuggestion('Run `! gcloud auth login` then `! az login`.')).toBe('az login')
    expect(lastSuggestion('Type this:\n\n```\n! aws sso login --profile dev\n```\n')).toBe('aws sso login --profile dev')
    expect(lastSuggestion('No command here!')).toBe(undefined)
    expect(lastSuggestion('Run `! ls\u202e -la`')).toBe(undefined)
    expect(lastSuggestion('Run `! echo a\u200bb`')).toBe(undefined)
  })

  test('formats output with the exit code', async () => {
    expect(formatResult('true', 0, '', '', false)).toBe('$ true\n(no output)\n[exit 0]')
    expect(formatResult('x', 2, 'a\n', 'b\n', false)).toBe('$ x\na\nb\n[exit 2]')
  })
})
