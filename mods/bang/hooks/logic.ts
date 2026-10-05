// Pure helpers for the bang mod.

export const MAX_OUTPUT = 20000

// The command in a prompt such as "! git status", or undefined when it is not one.
export function bangCommand(text: string): string | undefined {
  const m = /^\s*!\s*(\S[\s\S]*)$/.exec(text)
  return m?.[1]?.trim()
}

// The last "! command" in an assistant reply: an inline `! cmd`, or a line that starts with "!".
export function lastSuggestion(text: string): string | undefined {
  const found: { at: number; cmd: string }[] = []
  for (const m of text.matchAll(/`!\s*([^`\n]+)`/g)) found.push({ at: m.index ?? 0, cmd: m[1]!.trim() })
  for (const m of text.matchAll(/^[ \t]*!\s*([^\n`]+)$/gm)) found.push({ at: m.index ?? 0, cmd: m[1]!.trim() })
  found.sort((a, b) => a.at - b.at)
  return found.at(-1)?.cmd || undefined
}

export function formatResult(cmd: string, exitCode: number, stdout: string, stderr: string, timedOut: boolean): string {
  let out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]`
  const end = timedOut ? 'stopped after 10 minutes' : `exit ${exitCode}`
  return `$ ${cmd}\n${out || '(no output)'}\n[${end}]`
}
