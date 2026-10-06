import type { Build, Deploy, Watch } from '../types'

export const DEFAULT_URL = 'https://bamboo.rtsprod.net'
export const POLL_MS = 20_000
// How long to wait for Bamboo to start a build for a pushed commit.
export const START_WAIT_MS = 10 * 60_000
// How long to wait, after the build, for a deployment to start.
export const DEPLOY_WAIT_MS = 5 * 60_000
// A watch that runs longer than this stops.
export const MAX_WATCH_MS = 3 * 60 * 60_000
// A finished watch stays in the band this long.
export const SHOW_DONE_MS = 15 * 60_000

export const USAGE = [
  '/bamboo                show the builds this session watches',
  '/bamboo watch [sha]    watch the builds for a commit (default HEAD)',
  '/bamboo stop           stop every watch',
].join('\n')

export type Args = { kind: 'status' } | { kind: 'stop' } | { kind: 'watch'; sha?: string } | { kind: 'error'; text: string }

export function parseArgs(args: string): Args {
  const [verb, arg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (!verb) return { kind: 'status' }
  if (verb === 'stop' && !arg) return { kind: 'stop' }
  if (verb === 'watch' && rest.length === 0) {
    if (arg && !/^[0-9a-f]{7,40}$/i.test(arg)) return { kind: 'error', text: `${arg} is not a commit SHA.\n\n${USAGE}` }
    return { kind: 'watch', sha: arg }
  }
  return { kind: 'error', text: USAGE }
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2')
}

function resolve(dir: string, to: string): string {
  if (to.startsWith('/')) return to
  if (to.startsWith('~')) return to
  const parts = dir.split('/')
  for (const p of to.split('/')) {
    if (p === '..') parts.pop()
    else if (p && p !== '.') parts.push(p)
  }
  return parts.join('/') || '/'
}

// The folder of the repository that a Bash command pushes, or undefined when
// the command does not push. Follows `cd <dir> &&` and `git -C <dir> push`.
export function pushedRepo(command: string, cwd: string): string | undefined {
  let dir = cwd
  let found: string | undefined
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/).map(unquote)
    if (words[0] === 'cd' && words[1]) {
      dir = resolve(dir, words[1])
      continue
    }
    if (words[0] !== 'git') continue
    let i = 1
    let repo = dir
    while (words[i]?.startsWith('-')) {
      const target = words[i + 1]
      if (words[i] === '-C' && target) {
        repo = resolve(dir, target)
        i += 2
      } else i += words[i] === '-c' ? 2 : 1
    }
    if (words[i] !== 'push') continue
    const flags = words.slice(i + 1)
    if (flags.some(f => f === '--delete' || f === '-d' || f === '--dry-run' || f === '-n' || f === '--tags')) continue
    found = repo
  }
  return found
}

// True when a Bash command merges a Bitbucket pull request through the REST API.
// A GET on the same path only asks whether the pull request can merge.
export function isMerge(command: string): boolean {
  const isPost = /(-X|--request)\s*['"]?POST\b/.test(command) || /\s(-d|--data[\w-]*)[\s=]/.test(command)
  return isPost && /pull-requests\/\d+\/merge\b/.test(command)
}

// The merge commit from a Bitbucket merge response, when the output has one.
export function mergeCommit(output: string): string | undefined {
  return /"mergeCommit"\s*:\s*\{[^}]*?"id"\s*:\s*"([0-9a-f]{40})"/.exec(output)?.[1]
}

type Json = Record<string, any>

export function parseBuild(r: Json): Build {
  const plan = r.plan ?? {}
  const progress = r.progress ?? {}
  const isFinished = r.lifeCycleState === 'Finished' || r.finished === true
  return {
    key: String(r.key ?? r.buildResultKey),
    planKey: String(plan.key ?? ''),
    masterKey: String(plan.master?.key ?? plan.key ?? ''),
    branch: String(plan.shortName ?? ''),
    state: isFinished ? String(r.state ?? r.buildState ?? 'Unknown') : String(r.lifeCycleState ?? 'Pending'),
    isFinished,
    tests: typeof r.buildTestSummary === 'string' ? r.buildTestSummary : undefined,
    failed: Number(r.failedTestCount ?? 0),
    percent: isFinished ? undefined : progress.percentageCompletedPretty,
    remaining: isFinished ? undefined : progress.prettyTimeRemaining,
  }
}

// The deployment result in an environment's results that deploys `buildKey`.
export function deployFor(results: Json[], buildKey: string, environment: string): Deploy | undefined {
  const r = results.find(x =>
    (x.deploymentVersion?.items ?? []).some((i: Json) => i.planResultKey?.key === buildKey),
  )
  if (!r) return undefined
  const isFinished = r.lifeCycleState === 'FINISHED'
  return { id: Number(r.id), environment, state: isFinished ? String(r.deploymentState) : String(r.lifeCycleState), isFinished }
}

function buildText(b: Build): string {
  if (!b.isFinished) {
    const progress = [b.percent, b.remaining].filter(Boolean).join(', ')
    return `${b.key} ${b.state === 'InProgress' ? 'running' : b.state.toLowerCase()}${progress ? ` ${progress}` : ''}`
  }
  if (b.state === 'Successful') return `${b.key} passed${b.tests ? `, ${b.tests}` : ''}`
  return `${b.key} failed${b.tests ? `, ${b.tests}` : ''}`
}

function deployText(d: Deploy): string {
  if (!d.isFinished) return `deploying to ${d.environment}`
  return d.state === 'SUCCESS' ? `deployed to ${d.environment}` : `deploy to ${d.environment} ${d.state.toLowerCase()}`
}

// One line of the band for a watch.
export function watchLine(w: Watch): string {
  const short = w.sha.slice(0, 8)
  if (w.builds.length === 0) return w.outcome ?? `${short} waiting for Bamboo to start a build`
  const parts = [...w.builds.map(buildText), ...w.deploys.map(deployText)]
  return parts.join(' · ')
}

export type Step = { outcome?: string; isFailure?: boolean; checkDeploys: boolean }

// What the latest poll means for a watch: still going, or the outcome to report.
export function nextStep(w: Watch, now: number): Step {
  const short = w.sha.slice(0, 8)
  if (now - w.startedAt > MAX_WATCH_MS) return { outcome: `stopped watching ${short} after 3 hours`, checkDeploys: false }
  if (w.builds.length === 0) {
    if (now - w.startedAt > START_WAIT_MS) return { outcome: `no build started for ${short} in 10 minutes`, checkDeploys: false }
    return { checkDeploys: false }
  }
  if (w.builds.some(b => !b.isFinished)) return { checkDeploys: false }

  const failed = w.builds.filter(b => b.state !== 'Successful')
  if (failed.length > 0) return { outcome: failed.map(buildText).join(', '), isFailure: true, checkDeploys: false }

  const badDeploy = w.deploys.find(d => d.isFinished && d.state !== 'SUCCESS')
  if (badDeploy) return { outcome: `${w.builds.map(buildText).join(', ')}; ${deployText(badDeploy)}`, isFailure: true, checkDeploys: false }
  if (w.deploys.some(d => !d.isFinished)) return { checkDeploys: true }

  const waited = now - (w.builtAt ?? now)
  if (w.deploys.length === 0 && waited < DEPLOY_WAIT_MS) return { checkDeploys: true }
  return { outcome: [...w.builds.map(buildText), ...w.deploys.map(deployText)].join(', '), checkDeploys: false }
}

export function watchContext(sha: string): string {
  return [
    `The bamboo mod now watches the Bamboo builds and deployments for commit ${sha.slice(0, 12)}.`,
    'It shows progress above the prompt, sends a push notification when they finish, and adds the outcome to this conversation.',
    'Do not write a loop or a background command that polls Bamboo for this commit.',
  ].join(' ')
}
