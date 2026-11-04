// Pure logic for the election mod: read a New York Times results file, compare
// two readings, and format the status line. No engine calls here.

export type Party = 'D' | 'R' | 'I'

export type Call = {
  label: string
  winner: string
  party: Party
  isFlip: boolean
  isRunoff: boolean
}

export type Chamber = {
  dem: number
  rep: number
  other: number
  demFlips: number
  repFlips: number
  demToWin: number
  repToWin: number
  controlledBy?: Party
  calls: Record<string, Call>
}

export type Reading = { senate: Chamber; house: Chamber }

export type Announcement = { text: string; isMajor: boolean }

export function partyOf(id: unknown): Party {
  if (id === 'DEM') return 'D'
  if (id === 'GOP') return 'R'
  return 'I'
}

type Doc = {
  partyControlData?: { results?: { offices?: Record<string, Office> }[] }
  races?: Race[]
}
type Balance = { seats?: number; flip_count?: number; winner?: boolean }
type Office = { to_win?: Record<string, number>; party_balance?: Record<string, Balance> }
type Race = {
  nyt_id?: string
  seat_number?: string | null
  outcome?: { won?: string[]; advanced_to_runoff?: string[]; gained?: boolean | null }
  candidate_metadata?: Record<string, { last_name?: string; party?: { nyt_id?: string } }>
  top_reporting_unit?: { state_postal?: string }
}

/** Reads one results file. Throws when it does not have the expected shape. */
export function parseChamber(text: string, office: 'S' | 'H'): Chamber {
  const doc = JSON.parse(text) as Doc
  const data = doc.partyControlData?.results?.[0]?.offices?.[office]
  const balance = data?.party_balance
  if (!balance?.DEM || !balance.GOP || !Array.isArray(doc.races)) {
    throw new Error(`results file for ${office} has an unexpected shape`)
  }

  const calls: Record<string, Call> = {}
  for (const race of doc.races) {
    const won = race.outcome?.won ?? []
    const runoff = race.outcome?.advanced_to_runoff ?? []
    const id = won[0] ?? runoff[0]
    if (!race.nyt_id || !id) continue
    const state = race.top_reporting_unit?.state_postal ?? '??'
    const candidate = race.candidate_metadata?.[id]
    calls[race.nyt_id] = {
      label: office === 'H' ? `${state}-${race.seat_number ?? 'AL'}` : state,
      winner: candidate?.last_name ?? id,
      party: partyOf(candidate?.party?.nyt_id),
      isFlip: race.outcome?.gained === true,
      isRunoff: won.length === 0,
    }
  }

  const controlledBy = balance.DEM.winner ? 'D' : balance.GOP.winner ? 'R' : undefined
  return {
    dem: balance.DEM.seats ?? 0,
    rep: balance.GOP.seats ?? 0,
    other: balance.OTH?.seats ?? 0,
    demFlips: balance.DEM.flip_count ?? 0,
    repFlips: balance.GOP.flip_count ?? 0,
    demToWin: data?.to_win?.DEM ?? 0,
    repToWin: data?.to_win?.GOP ?? 0,
    ...(controlledBy ? { controlledBy } : {}),
    calls,
  }
}

function seats(c: Chamber): string {
  return `D ${c.dem}, R ${c.rep}${c.other ? `, I ${c.other}` : ''}`
}

function describeCall(c: Call): string {
  const name = `${c.label} ${c.winner} (${c.party})`
  if (c.isRunoff) return `${c.label} goes to a runoff`
  return c.isFlip ? `${name} FLIP` : name
}

function newCalls(prev: Chamber, next: Chamber): Call[] {
  return Object.entries(next.calls)
    .filter(([id]) => !prev.calls[id])
    .map(([, call]) => call)
}

const PARTY_NAME: Record<Party, string> = { D: 'Democrats', R: 'Republicans', I: 'Independents' }

/** Lists what changed. Each Senate call is its own line, and House calls share one line. */
export function announcements(prev: Reading, next: Reading): Announcement[] {
  const out: Announcement[] = []

  for (const call of newCalls(prev.senate, next.senate)) {
    out.push({ text: `Senate: ${describeCall(call)}. Now ${seats(next.senate)}.`, isMajor: true })
  }

  const house = newCalls(prev.house, next.house)
  if (house.length > 0) {
    const flips = house.filter(c => c.isFlip).map(describeCall)
    const count = (p: Party) => house.filter(c => c.party === p && !c.isRunoff).length
    const flipText = flips.length > 0 ? ` ${flips.join(', ')}.` : ''
    out.push({
      text: `House: ${house.length} new (D ${count('D')}, R ${count('R')}).${flipText} Now ${seats(next.house)}.`,
      isMajor: flips.length > 0,
    })
  }

  for (const [name, key] of [['Senate', 'senate'], ['House', 'house']] as const) {
    const winner = next[key].controlledBy
    if (winner && winner !== prev[key].controlledBy) {
      out.push({ text: `${PARTY_NAME[winner]} win control of the ${name}.`, isMajor: true })
    }
  }
  return out
}

const ESC = '\u001b'
const paint = (bg: number, fg: number, text: string) =>
  `${ESC}[48;5;${bg}m${ESC}[38;5;${fg}m${text}${ESC}[0m`
const dim = (text: string) => `${ESC}[38;5;245m${text}${ESC}[0m`

const DEM_BG = 27
const REP_BG = 160
const OTHER_BG = 240
const WHITE = 231

function chip(label: string, c: Chamber): string {
  const crown = (p: Party) => (c.controlledBy === p ? '★' : '')
  const flip = (n: number) => (n > 0 ? `+${n}` : '')
  return (
    dim(`${label} `) +
    paint(DEM_BG, WHITE, ` ${crown('D')}${c.dem}${flip(c.demFlips)} `) +
    paint(REP_BG, WHITE, ` ${crown('R')}${c.rep}${flip(c.repFlips)} `) +
    (c.other > 0 ? paint(OTHER_BG, WHITE, ` ${c.other} `) : '') +
    dim(` /${Math.max(c.demToWin, c.repToWin)}`)
  )
}

/** The colored prefix for the status line. */
export function statusLine(r: Reading): string {
  return `${chip('Sen', r.senate)} ${chip('Hse', r.house)}`
}

/** The plain text reply for /election. */
export function summary(r: Reading, recent: readonly string[]): string {
  const line = (name: string, c: Chamber) => {
    const need = c.demToWin === c.repToWin ? `${c.demToWin}` : `D ${c.demToWin}, R ${c.repToWin}`
    const flips = `flips D ${c.demFlips}, R ${c.repFlips}`
    return `${name}: ${seats(c)} (needed: ${need}; ${flips})`
  }
  const log = recent.length > 0 ? `\n\nLatest:\n${recent.map(t => `- ${t}`).join('\n')}` : ''
  return `${line('Senate', r.senate)}\n${line('House', r.house)}\n\nThese are projections, not official results.${log}`
}
