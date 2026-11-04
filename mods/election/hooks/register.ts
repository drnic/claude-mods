import type { EngineInterface, Register } from 'claude-code'

import { type Reading, announcements, parseChamber, statusLine, summary } from './logic'

// Polls the New York Times results files, and writes a colored line that
// ~/.claude/statusline-command.sh puts first on the status line. New race calls
// show as a transcript line and a toast. A Senate call, a flip, or a change of
// control also raises a native notification.
//
// All sessions share one state file, so only one session fetches per period.
// Each session keeps its own place in the shared list of announcements.

const BASE = 'https://static01.nyt.com/elections-assets/pages/data/2026-11-03'
const CHECK_MS = 30_000
const FETCH_EVERY_MS = 120_000
const CLAIM_MS = 60_000
const MAX_LOG = 200
// The end of 5 Nov 2026 in Brisbane. After this the mod stops, and the status
// line script drops the line when the file is 30 minutes old.
const STOP_AT = Date.UTC(2026, 10, 5, 14)

type Shared = {
  fetchedAt: number
  claimedAt: number
  seq: number
  log: { seq: number; text: string; isMajor: boolean }[]
  reading?: Reading
  lastError?: string
}

const EMPTY: Shared = { fetchedAt: 0, claimedAt: 0, seq: 0, log: [] }

async function paths($: EngineInterface) {
  const home = await $.env.get('HOME')
  const dir = `${home}/.claude/election`
  return { state: `${dir}/state.json`, status: `${dir}/status` }
}

async function load($: EngineInterface, path: string): Promise<Shared> {
  try {
    return JSON.parse(await $.fs.read(path)) as Shared
  } catch {
    return EMPTY
  }
}

// $.http.fetch cuts a response off at 4 MiB, and the House file is over 9 MB. So
// curl fetches each file, and jq keeps only the called races before the mod reads it.
const KEEP_CALLED = `{
  partyControlData,
  races: [.races[]
    | select((.outcome.won | length > 0) or (.outcome.advanced_to_runoff | length > 0))
    | {nyt_id, seat_number, outcome, candidate_metadata,
       top_reporting_unit: {state_postal: .top_reporting_unit.state_postal}}]
}`

async function fetchChamber($: EngineInterface, office: 'S' | 'H') {
  const name = office === 'S' ? 'senate' : 'house'
  const url = `${BASE}/results-${name}.json`
  const script = 'set -o pipefail; curl -fsSL --compressed --max-time 45 "$1" | jq -c "$2"'
  // A session's own folder can be deleted while it runs (a removed worktree), and
  // then every spawn from it fails with ENOENT. So run from the home folder.
  const res = await $.process.run(['bash', '-c', script, 'election', url, KEEP_CALLED], {
    cwd: await $.env.get('HOME'),
    stdin: '',
    timeoutMs: 60_000,
  })
  if (res.exitCode !== 0) throw new Error(`${name} results: exit ${res.exitCode}: ${res.stderr.trim()}`)
  return parseChamber(res.stdout, office)
}

async function poll($: EngineInterface, now: number): Promise<void> {
  const file = await paths($)
  const shared = await load($, file.state)
  if (now - shared.fetchedAt < FETCH_EVERY_MS || now - shared.claimedAt < CLAIM_MS) return

  await $.fs.write(file.state, JSON.stringify({ ...shared, claimedAt: now }))
  let reading: Reading
  try {
    const [senate, house] = await Promise.all([fetchChamber($, 'S'), fetchChamber($, 'H')])
    reading = { senate, house }
  } catch (err) {
    // Give the claim back. All sessions check on the same period, so the session
    // that holds a claim is always the first to see it expire. If it kept the
    // claim, one failing session would stop all the other sessions from fetching.
    await $.fs.write(file.state, JSON.stringify({ ...shared, claimedAt: 0, lastError: String(err) }))
    throw err
  }

  let seq = shared.seq
  const added = shared.reading
    ? announcements(shared.reading, reading).map(a => ({ ...a, seq: ++seq }))
    : []
  const log = [...shared.log, ...added].slice(-MAX_LOG)
  const next: Shared = { fetchedAt: now, claimedAt: now, seq, log, reading }
  await $.fs.write(file.state, JSON.stringify(next))
  await $.fs.write(file.status, statusLine(reading))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'election',
      description: 'Show the latest 2026 US Senate and House seat counts and race calls',
    })

    // Start at the latest announcement, so a new session does not replay old ones.
    let seen: number | undefined

    const tick = async () => {
      try {
        const now = await $.clock.now()
        if (now >= STOP_AT) {
          timer.cancel()
          return
        }
        await poll($, now)
        const shared = await load($, (await paths($)).state)
        if (seen === undefined) seen = shared.seq
        const fresh = shared.log.filter(a => a.seq > (seen ?? 0))
        seen = shared.seq
        for (const a of fresh) {
          $.ui.log(a.text)
          $.ui.toast(a.text, { timeoutMs: 15_000 })
          if (a.isMajor) await $.ui.notify(a.text, { title: 'Election' }).catch(() => undefined)
        }
      } catch (err) {
        $.ui.log(`election: poll failed: ${String(err)}`, { to: 'debug' })
      }
    }

    const timer = $.clock.every(CHECK_MS, () => void tick())
    $.clock.after(0, () => void tick())
    return next(e)
  })

  on('command.run', { command: 'election' }, async $ => {
    const shared = await load($, (await paths($)).state)
    const error = shared.lastError ? `Last fetch failed: ${shared.lastError}` : undefined
    if (!shared.reading) return { text: error ?? 'No results yet. The first fetch runs within a minute.' }
    const text = summary(shared.reading, shared.log.slice(-10).map(a => a.text))
    return { text: error ? `${text}\n\n${error}` : text }
  })
}
