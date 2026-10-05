import { describe, expect, test } from 'claude-code/testing'

import { chooseMode, DONE_MARKER, parseArgs, phasePrompt, isPhasePrompt, planForBranch, stopReason } from './logic'

const ok = { headMoved: true, isClean: true, isPushed: true }

describe('phase logic', () => {
  test('clears the context at or above the threshold', async () => {
    expect(chooseMode(39, 40)).toBe('keep')
    expect(chooseMode(40, 40)).toBe('fresh')
    expect(chooseMode(90, 40, 'keep')).toBe('keep')
  })

  test('stops when a phase did not commit and push, or the plan is done', async () => {
    expect(stopReason('done', ok)).toBe(undefined)
    expect(stopReason(DONE_MARKER, ok)).toBe('the plan says every step is done')
    expect(stopReason('x', { ...ok, headMoved: false })).toBe('the last phase made no commit')
    expect(stopReason('x', { ...ok, isPushed: false })).toBe('the last commit is not pushed')
  })

  test('reads the arguments', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs('auto 5')).toEqual({ kind: 'auto', count: 5, plan: undefined })
    expect(parseArgs('next fresh mydocs/a-plan.md')).toEqual({ kind: 'next', mode: 'fresh', plan: 'mydocs/a-plan.md' })
    expect(parseArgs('auto 0').kind).toBe('error')
  })

  test('finds the plan from the branch ticket and knows its own prompt', async () => {
    const files = ['HI-3343-final-evidence-zip-plan.md', 'HI-3356-sqs-notifications-plan.md']
    expect(planForBranch('HI-3343-produce-the-final-evidence-zip', files)).toBe('mydocs/HI-3343-final-evidence-zip-plan.md')
    expect(planForBranch('main', files)).toBe(undefined)
    const plan = 'mydocs/HI-3343-final-evidence-zip-plan.md'
    expect(isPhasePrompt(phasePrompt(plan), plan)).toBe(true)
  })
})
