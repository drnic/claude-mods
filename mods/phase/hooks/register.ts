import type { EngineInterface, Register } from 'claude-code'

import {
  DEFAULT_THRESHOLD,
  USAGE,
  chooseMode,
  isPhasePrompt,
  parseArgs,
  phasePrompt,
  planForBranch,
  stopReason,
  type Mode,
  type Run,
} from './logic'

// Runs a plan document one phase at a time, in place of bin/ralph.
// Each phase starts with /clear when the context is at or above the threshold,
// and in the same session when it is below.

type $ = EngineInterface

const runKey = (root: string) => `run:${root}`
const planKey = (root: string) => `plan:${root}`
const THRESHOLD_KEY = 'threshold'

async function git($: $, root: string, args: string[]) {
  const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 15000 })
  return { ok: r.exitCode === 0, out: r.stdout.trim() }
}

async function threshold($: $): Promise<number> {
  const v = await $.store.get(THRESHOLD_KEY)
  return typeof v === 'number' ? v : DEFAULT_THRESHOLD
}

async function resolvePlan($: $, root: string, given?: string): Promise<string | undefined> {
  if (given) {
    if (!(await $.fs.exists(`${root}/${given}`)) && !(await $.fs.exists(given))) return undefined
    await $.store.set(planKey(root), given)
    return given
  }
  const saved = await $.store.get(planKey(root))
  if (typeof saved === 'string') return saved
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  if (!(await $.fs.exists(`${root}/mydocs`))) return undefined
  const files = (await $.fs.list(`${root}/mydocs`)).map(f => f.name)
  const found = planForBranch(branch, files)
  if (found) await $.store.set(planKey(root), found)
  return found
}

function notice($: $, text: string) {
  $.ui.toast(text, { timeoutMs: 8000 })
  void $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: `phase: ${text}` }] } })
    .catch(() => undefined)
}

async function showStatus($: $, root: string) {
  const run = (await $.store.get(runKey(root))) as Run | undefined
  $.ui.status(run && run.remaining > 0 ? `phase: ${run.remaining} to go` : undefined)
}

// Starts one phase. Runs outside any hook, from a timer, because /clear and
// a submitted prompt both wait for the session to be idle.
async function startPhase($: $, root: string, plan: string, forced?: Mode) {
  const { context } = await $.session.usage()
  const mode = chooseMode(context.percent, await threshold($), forced)
  const head = (await git($, root, ['rev-parse', 'HEAD'])).out
  const run = (await $.store.get(runKey(root))) as Run | undefined
  if (run) await $.store.set(runKey(root), { ...run, startHead: head })
  await git($, root, ['push'])
  if (mode === 'fresh') {
    try {
      await $.command.run({ command: 'clear' })
    } catch {
      await $.session.compact({ instructions: `Keep only what the next phase of ${plan} needs.` })
    }
  }
  await $.prompt.submit({ text: phasePrompt(plan) })
}

export const register: Register = on => {
  // The turn id of the phase prompt this mod submitted, so turn.complete knows its own turns.
  let phaseTurn: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'phase',
      description: 'Run the next phase of a plan document, or N phases in a row',
      argumentHint: '[next|auto N|stop|plan <path>|threshold <pct>]',
    })
    await showStatus($, await $.session.root())
    return next(e)
  })

  on('command.run', { command: 'phase' }, async ($, e) => {
    const root = await $.session.root()
    const p = parseArgs(e.args)
    if (p.kind === 'error') return { text: p.text }

    if (p.kind === 'threshold') {
      await $.store.set(THRESHOLD_KEY, p.value)
      return { text: `Each phase now starts with /clear when the context is ${p.value}% full or more.` }
    }

    if (p.kind === 'stop') {
      await $.store.delete(runKey(root))
      await showStatus($, root)
      return { text: 'The auto run stops. A phase that is running now still finishes.' }
    }

    const plan = await resolvePlan($, root, 'plan' in p ? p.plan : undefined)

    if (p.kind === 'status' || p.kind === 'plan') {
      const run = (await $.store.get(runKey(root))) as Run | undefined
      const { context } = await $.session.usage()
      const lines = [
        `Plan: ${plan ?? 'none found. Use /phase plan mydocs/<file>.md'}`,
        `Auto run: ${run && run.remaining > 0 ? `${run.remaining} phases to go` : 'off'}`,
        `Context: ${context.percent ?? 0}% full. /clear before a phase at ${await threshold($)}% or more.`,
      ]
      return { text: p.kind === 'status' ? `${lines.join('\n')}\n\n${USAGE}` : lines[0] }
    }

    if (!plan) return { text: 'No plan found for this folder. Use /phase plan mydocs/<file>.md first.' }

    if (p.kind === 'auto') {
      await $.store.set(runKey(root), { plan, remaining: p.count, threshold: await threshold($) })
      await showStatus($, root)
    }
    const forced = p.kind === 'next' ? p.mode : undefined
    $.clock.after(500, () => void startPhase($, root, plan, forced).catch(err => notice($, `could not start: ${err}`)))
    return { text: `Starting the next phase of ${plan}.` }
  })

  on('turn.start', async ($, e, next) => {
    const root = await $.session.root()
    const plan = await $.store.get(planKey(root))
    if (typeof plan === 'string' && isPhasePrompt(e.text, plan)) phaseTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.turnId !== phaseTurn) return result
    phaseTurn = undefined

    const root = await $.session.root()
    const run = (await $.store.get(runKey(root))) as Run | undefined
    if (!run || run.remaining <= 0) return result

    if (e.isAborted || e.reason !== 'answer') {
      await $.store.delete(runKey(root))
      notice($, 'auto run stopped because the phase turn did not finish.')
      await showStatus($, root)
      return result
    }

    const head = (await git($, root, ['rev-parse', 'HEAD'])).out
    const dirty = (await git($, root, ['status', '--porcelain', '--untracked-files=no'])).out
    const ahead = await git($, root, ['rev-list', '--count', '@{u}..HEAD'])
    const why = stopReason(e.answer, {
      headMoved: head !== run.startHead,
      isClean: dirty === '',
      isPushed: ahead.ok && ahead.out === '0',
    })
    const remaining = run.remaining - 1

    if (why || remaining === 0) {
      await $.store.delete(runKey(root))
      notice($, why ? `auto run stopped: ${why}.` : 'auto run finished.')
    } else {
      await $.store.set(runKey(root), { ...run, remaining })
      $.clock.after(3000, () => void startPhase($, root, run.plan).catch(err => notice($, `could not start: ${err}`)))
    }
    await showStatus($, root)
    return result
  })
}
