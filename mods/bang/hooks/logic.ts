// Pure helpers for the bang mod.

export const MAX_OUTPUT = 20000

// The command in a prompt such as "! git status", or undefined when it is not one.
export function bangCommand(text: string): string | undefined {
  const m = /^\s*!\s*(\S[\s\S]*)$/.exec(text)
  return m?.[1]?.trim()
}

// Characters that can hide part of a command on screen: control characters,
// zero-width spaces and text-direction marks.
const HIDDEN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

// The last "! command" in an assistant reply: an inline `! cmd`, or a line that starts with "!".
export function lastSuggestion(text: string): string | undefined {
  const found: { at: number; cmd: string }[] = []
  for (const m of text.matchAll(/`!\s*([^`\n]+)`/g)) found.push({ at: m.index ?? 0, cmd: m[1]!.trim() })
  for (const m of text.matchAll(/^[ \t]*!\s*([^\n`]+)$/gm)) found.push({ at: m.index ?? 0, cmd: m[1]!.trim() })
  found.sort((a, b) => a.at - b.at)
  const cmd = found.at(-1)?.cmd
  return cmd && !HIDDEN.test(cmd) ? cmd : undefined
}

export function formatResult(cmd: string, exitCode: number, stdout: string, stderr: string, timedOut: boolean): string {
  let out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]`
  const end = timedOut ? 'stopped after 10 minutes' : `exit ${exitCode}`
  return `$ ${cmd}\n${out || '(no output)'}\n[${end}]`
}
