import type { EngineInterface, Register } from 'claude-code'

import { bangCommand, formatResult, lastSuggestion } from './logic'

// Lets a Remote Control client (the iOS app, claude.ai) run a shell command on
// this machine the way `!` does in the terminal. Two ways in:
//   "! git status" sent from the phone runs that command.
//   /run with no arguments shows the last `! command` Claude suggested, and
//   /run ok runs exactly that command. Claude's text never reaches the shell
//   until you have seen the command and confirmed it.
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
  // The suggested command that /run showed, waiting for /run ok.
  let pending: string | undefined

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
    const args = e.args.trim()
    if (args === 'ok') {
      const cmd = pending
      pending = undefined
      if (!cmd) return { text: 'Nothing is waiting. Send /run first to see the suggested command.' }
      return { text: await runShell($, cmd) }
    }
    if (args) {
      pending = undefined
      return { text: await runShell($, args) }
    }
    pending = await suggested($)
    if (!pending) return { text: 'Claude has not suggested a ! command in this session.' }
    return { text: `Claude suggested this command:\n\n${pending}\n\nSend /run ok to run exactly this command.` }
  })
}
