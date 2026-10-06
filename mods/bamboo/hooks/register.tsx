import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Build, Deploy, Watch } from '../types'
import {
  DEFAULT_URL,
  POLL_MS,
  SHOW_DONE_MS,
  USAGE,
  deployFor,
  isMerge,
  mergeCommit,
  nextStep,
  parseArgs,
  parseBuild,
  pushedRepo,
  watchContext,
  watchLine,
} from './logic'

// Watches the Bamboo builds for a commit after `git push` or a Bitbucket pull
// request merge, then the deployments of those builds. Progress shows in a
// band above the prompt. The outcome goes out as a push notification and as a
// message that Claude reads, so Claude does not write its own polling loop.

type $ = EngineInterface

const watches = atom({ plugin: 'bamboo', key: 'watches' } as const, [] as Watch[])

async function bamboo($: $, path: string): Promise<any> {
  const base = ((await $.env.get('BAMBOO_URL')) ?? DEFAULT_URL).replace(/\/$/, '')
  const token = await $.env.get('BAMBOO_API_KEY')
  if (!token) throw new Error('BAMBOO_API_KEY is not set')
  // JSON needs the Accept header: a .json suffix makes this Bamboo fail.
  const r = await $.http.fetch(`${base}/rest/api/latest/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`Bamboo answered ${r.status} for ${path}`)
  return JSON.parse(r.text)
}

async function git($: $, repo: string, args: string[]): Promise<string | undefined> {
  const r = await $.process.run(['git', ...args], { cwd: repo, timeoutMs: 15000 })
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

async function addWatch($: $, repo: string, sha: string, reason: string) {
  const now = await $.clock.now()
  await update($, watches, ws => [
    ...ws.filter(w => w.sha !== sha && (!w.finishedAt || now - w.finishedAt < SHOW_DONE_MS)),
    { sha, repo, reason, startedAt: now, builds: [], deploys: [] },
  ])
  $.ui.status(`watching ${sha.slice(0, 8)}`)
}

async function builds($: $, w: Watch): Promise<Build[]> {
  const found = await bamboo($, `result/byChangeset/${w.sha}?expand=results.result&includeAllStates=true`)
  const list: Build[] = (found.results?.result ?? []).map(parseBuild)
  // byChangeset leaves out the progress of a running build: ask for each one.
  return Promise.all(
    list.map(async b => (b.isFinished ? b : parseBuild(await bamboo($, `result/${b.key}?includeAllStates=true`)))),
  )
}

async function deploys($: $, w: Watch, environments: Map<string, { id: number; name: string }[]>): Promise<Deploy[]> {
  const out: Deploy[] = []
  for (const b of w.builds) {
    let envs = environments.get(b.masterKey)
    if (!envs) {
      const projects = await bamboo($, `deploy/project/forPlan?planKey=${b.masterKey}`)
      envs = []
      for (const p of projects ?? []) {
        const project = await bamboo($, `deploy/project/${p.id}`)
        for (const e of project.environments ?? []) envs.push({ id: e.id, name: e.name })
      }
      environments.set(b.masterKey, envs)
    }
    for (const e of envs) {
      const results = await bamboo($, `deploy/environment/${e.id}/results?max-results=5`)
      const d = deployFor(results.results ?? [], b.key, e.name)
      if (d) out.push(d)
    }
  }
  return out
}

async function report($: $, w: Watch, outcome: string, isFailure: boolean) {
  const text = `Bamboo: ${outcome}`
  $.ui.toast(text, { timeoutMs: 10000 })
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text }] } })
    .catch(() => undefined)
  await $.session
    .append({
      message: {
        type: 'user',
        content: [{ type: 'text', text: `The bamboo mod reports for commit ${w.sha.slice(0, 12)}: ${outcome}${isFailure ? '. This is a failure.' : '.'}` }],
      },
    })
    .catch(() => undefined)
  await $.tool.call({ tool: 'PushNotification', message: text.slice(0, 200), status: 'proactive' }).catch(() => undefined)
}

// Module values start over on each reload; the watches live in $.state.
// When the last poll started, while it runs. A poll that runs longer than
// STALE_POLL_MS (a request that never answers) no longer blocks the next one.
let pollingSince: number | undefined
const STALE_POLL_MS = 2 * 60_000
// Deployment environments per master plan key, read once per load.
const environments = new Map<string, { id: number; name: string }[]>()
let lastError: string | undefined

async function poll($: $) {
  const now = await $.clock.now()
  if (pollingSince !== undefined && now - pollingSince < STALE_POLL_MS) return
  pollingSince = now
  try {
    for (const w of await read($, watches)) {
      if (w.outcome) continue
      let next: Watch = w
      try {
        const found = await builds($, w)
        const firstDone = found.length > 0 && found.every(b => b.isFinished)
        next = { ...w, builds: found, builtAt: firstDone ? (w.builtAt ?? now) : undefined }
        if (nextStep(next, now).checkDeploys) next = { ...next, deploys: await deploys($, next, environments) }
        lastError = undefined
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== lastError) $.ui.toast(`bamboo: ${msg}`, { timeoutMs: 8000 })
        lastError = msg
      }
      const step = nextStep(next, now)
      if (step.outcome) next = { ...next, outcome: step.outcome, isFailure: step.isFailure === true, finishedAt: now }
      const done = next
      await update($, watches, ws => ws.map(x => (x.sha === done.sha ? done : x)))
      // The push notification can wait on a permission dialog: do not hold the poll for it.
      if (step.outcome) void report($, done, step.outcome, step.isFailure === true).catch(() => undefined)
    }
    const active = (await read($, watches)).filter(w => !w.outcome).length
    $.ui.status(active > 0 ? `watching ${active}` : undefined)
  } finally {
    pollingSince = undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bamboo',
      description: 'Show or start a watch on the Bamboo builds for a commit',
      argumentHint: '[watch [sha]|stop]',
    })
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const cwd = await $.session.cwd()
    const repo = pushedRepo(e.command, cwd)
    let sha: string | undefined
    let reason = 'push'
    if (repo) {
      sha = await git($, repo, ['rev-parse', 'HEAD'])
    } else if (isMerge(e.command)) {
      reason = 'merge'
      sha = mergeCommit(ran.text ?? '')
    }
    if (!sha) return ran

    await addWatch($, repo ?? cwd, sha, reason)
    $.clock.after(3000, () => void poll($))
    return { ...ran, context: [...(ran.context ?? []), watchContext(sha)] }
  })

  on('command.run', { command: 'bamboo' }, async ($, e) => {
    const p = parseArgs(e.args)
    if (p.kind === 'error') return { text: p.text }

    if (p.kind === 'stop') {
      await update($, watches, () => [])
      $.ui.status(undefined)
      return { text: 'Stopped every Bamboo watch.' }
    }

    if (p.kind === 'watch') {
      const cwd = await $.session.cwd()
      const sha = await git($, cwd, ['rev-parse', p.sha ?? 'HEAD'])
      if (!sha) return { text: `Could not find commit ${p.sha ?? 'HEAD'} in ${cwd}.` }
      await addWatch($, cwd, sha, 'command')
      $.clock.after(0, () => void poll($))
      return { text: `Watching the Bamboo builds for ${sha.slice(0, 12)}.` }
    }

    const ws = await read($, watches)
    if (ws.length === 0) return { text: `No Bamboo watches in this session.\n\n${USAGE}` }
    return { text: ws.map(w => `${w.sha.slice(0, 8)} (${w.reason}): ${w.outcome ?? watchLine(w)}`).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const shown = (await read($, watches)).filter(w => !w.finishedAt || now - w.finishedAt < SHOW_DONE_MS)
    if (shown.length === 0 || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {shown.slice(-3).map(w => {
          const color = !w.outcome ? undefined : w.isFailure ? 'error' : 'success'
          return (
            <Text key={w.sha} color={color} dimColor={!w.outcome} wrap="truncate-end">
              Bamboo {watchLine(w)}
            </Text>
          )
        })}
      </Box>
    )
  })
}
