// Pure helpers for the phase mod, kept apart so tests can run them without a session.

export const DONE_MARKER = 'ALL PHASES DONE'
export const DEFAULT_THRESHOLD = 40

export type Mode = 'fresh' | 'keep'

export type Run = {
  plan: string
  remaining: number
  threshold: number
  startHead?: string
}

export function phasePrompt(plan: string): string {
  return [
    `Read ${plan} and implement the next step or phase that is not done yet.`,
    'Use git log and the code to tell what is already done.',
    'When the step is finished and its tests pass, commit and push.',
    'Do not start background tasks or watch CI in this run.',
    'If you need a decision from me, stop and ask.',
    `If every step is already done, change nothing and reply with exactly: ${DONE_MARKER}`,
  ].join(' ')
}

export function isPhasePrompt(text: string, plan: string): boolean {
  return text.startsWith(`Read ${plan} and implement the next step`)
}

export function chooseMode(percent: number | undefined, threshold: number, forced?: Mode): Mode {
  if (forced) return forced
  return (percent ?? 0) >= threshold ? 'fresh' : 'keep'
}

export type StepCheck = { headMoved: boolean; isClean: boolean; isPushed: boolean }

// Why the auto run stops after a phase turn, or undefined to go on.
export function stopReason(answer: string, check: StepCheck): string | undefined {
  if (answer.includes(DONE_MARKER)) return 'the plan says every step is done'
  if (!check.headMoved) return 'the last phase made no commit'
  if (!check.isClean) return 'the working tree has uncommitted changes'
  if (!check.isPushed) return 'the last commit is not pushed'
  return undefined
}

export type Parsed =
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'next'; mode?: Mode; plan?: string }
  | { kind: 'auto'; count: number; plan?: string }
  | { kind: 'plan'; plan?: string }
  | { kind: 'threshold'; value: number }
  | { kind: 'error'; text: string }

export const USAGE = [
  '/phase                    show the plan, the auto run and the context fill',
  '/phase next [fresh|keep]  run the next phase now',
  '/phase auto N             run N phases, one after another',
  '/phase stop               stop the auto run after the current phase',
  '/phase plan <path>        set the plan for this folder',
  '/phase threshold <pct>    clear the context first at or above this fill',
  'Any of next, auto and plan also takes a plan path.',
].join('\n')

export function parseArgs(args: string): Parsed {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb, ...rest] = words
  const planIn = (list: string[]) => list.find(w => w.endsWith('.md'))
  switch (verb) {
    case undefined:
    case 'status':
      return { kind: 'status' }
    case 'stop':
      return { kind: 'stop' }
    case 'next': {
      const mode = rest.find(w => w === 'fresh' || w === 'keep') as Mode | undefined
      return { kind: 'next', mode, plan: planIn(rest) }
    }
    case 'auto': {
      const count = Number(rest.find(w => /^\d+$/.test(w)) ?? '1')
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        return { kind: 'error', text: 'auto needs a count from 1 to 50.' }
      }
      return { kind: 'auto', count, plan: planIn(rest) }
    }
    case 'plan':
      return { kind: 'plan', plan: planIn(rest) }
    case 'threshold': {
      const value = Number(rest[0])
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return { kind: 'error', text: 'threshold needs a percent from 0 to 100.' }
      }
      return { kind: 'threshold', value }
    }
    default:
      if (verb.endsWith('.md')) return { kind: 'plan', plan: verb }
      return { kind: 'error', text: `Unknown word: ${verb}\n\n${USAGE}` }
  }
}

// Picks the plan for a branch such as HI-3343-produce-... from files in mydocs/.
export function planForBranch(branch: string, files: string[]): string | undefined {
  const ticket = /^([A-Z]+-\d+)/.exec(branch)?.[1]
  if (!ticket) return undefined
  const hits = files.filter(f => f.startsWith(ticket) && f.endsWith('-plan.md'))
  return hits.length === 1 ? `mydocs/${hits[0]}` : undefined
}
