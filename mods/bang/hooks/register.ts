import type { EngineInterface, Register } from 'claude-code'

import { bangCommand, formatResult, lastSuggestion } from './logic'

// Lets a Remote Control client (the iOS app, claude.ai) run a shell command on
// this machine the way `!` does in the terminal. Two ways in:
//   "! git status" sent from the phone runs that command.
//   /run with no arguments runs the last `! command` Claude suggested.
// The output lands in the transcript, where Claude reads it too.

async function runShell($: EngineInterface, cmd: string): Promise<string> {
  const cwd = await $.session.cwd()
  try {
    const r = await $.process.run(['zsh', '-lc', cmd], { cwd, stdin: '', timeoutMs: 600000 })
    return formatResult(cmd, r.exitCode, r.stdout, r.stderr, false)
  } catch {
    return formatResult(cmd, 1, '', '', true)
  }
}

async function suggested($: EngineInterface): Promise<string | undefined> {
  const messages = await $.session.messages()
  for (const m of [...messages].reverse()) {
    if (m.role !== 'assistant') continue
    const cmd = lastSuggestion(m.text)
    if (cmd) return cmd
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'run',
      description: 'Run a shell command on this machine, or the last ! command Claude suggested',
      argumentHint: '[command]',
    })
    return next(e)
  })

  // A "!" prompt from the phone or web never reaches the model as text: it runs as /run.
  on('prompt.submit', async ($, e, next) => {
    const cmd = e.origin.kind === 'bridge' ? bangCommand(e.text) : undefined
    if (!cmd) return next(e)
    $.clock.after(0, () => void $.command.run({ command: 'run', args: cmd }).catch(() => undefined))
    return { drop: `Running on the machine: ${cmd}` }
  })

  on('command.run', { command: 'run' }, async ($, e) => {
    // Only a person (at the terminal or through Remote Control) or this mod may run commands.
    const by = e.origin.kind
    const isOwn = by === 'plugin' && e.origin.name === 'bang'
    if (by !== 'composer' && by !== 'bridge' && !isOwn) {
      return { text: '/run only runs commands that you send yourself.' }
    }
    const cmd = e.args.trim() || (await suggested($))
    if (!cmd) return { text: 'No command given, and Claude has not suggested a ! command in this session.' }
    return { text: await runShell($, cmd) }
  })
}
