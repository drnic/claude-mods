import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/me'
const STATE = `${HOME}/.claude/election/state.json`
const STATUS = `${HOME}/.claude/election/status`
const NOW = Date.UTC(2026, 10, 4)

const results = (office: 'S' | 'H') =>
  JSON.stringify({
    partyControlData: {
      results: [
        {
          offices: {
            [office]: {
              to_win: { DEM: 51, GOP: 50 },
              party_balance: { DEM: { seats: 45 }, GOP: { seats: 35 } },
            },
          },
        },
      ],
    },
    races: [],
  })

type On = Parameters<Parameters<typeof test>[1]>[1]

function world(on: On, run: (argv: readonly string[], cwd?: string) => { exitCode: number; stdout: string }) {
  const files = new Map([[STATE, JSON.stringify({ fetchedAt: 0, claimedAt: 0, seq: 0, log: [] })]])
  on('env.get', () => ({ value: HOME }))
  on('command.register', () => ({ value: { command: 'election' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => ({
    value: { stderr: '', ...run(e.argv, e.init?.cwd) },
  }))
  return files
}

describe('election polling', () => {
  test('fetches from the home folder, so a deleted session folder does no harm', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const cwds: (string | undefined)[] = []
    const files = world(on, (argv, cwd) => {
      cwds.push(cwd)
      return { exitCode: 0, stdout: results(argv[4]?.includes('senate') ? 'S' : 'H') }
    })

    await $.session.start({ cwd: '/deleted/worktree', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(cwds).toEqual([HOME, HOME])
    expect(files.get(STATUS)).toContain('Sen')
  })

  test('a failed fetch gives the claim back and records the error', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = world(on, () => ({ exitCode: 7, stdout: '' }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    const state = JSON.parse(files.get(STATE) ?? '{}')
    expect(state.claimedAt).toBe(0)
    expect(state.lastError).toContain('exit 7')
  })
})
