import { describe, expect, test } from 'claude-code/testing'

import type { Watch } from '../types'
import { DEPLOY_WAIT_MS, START_WAIT_MS, deployFor, isMerge, mergeCommit, nextStep, parseArgs, parseBuild, pushedRepo, watchLine } from './logic'

const sha = '39093aa41da2656179f702ffa953aed368a95ae4'

const branchResult = {
  key: 'TG-TGS68-12',
  state: 'Successful',
  lifeCycleState: 'Finished',
  buildTestSummary: '1302 passed',
  failedTestCount: 0,
  plan: { key: 'TG-TGS68', shortName: 'HI-3343-produce-the-final-evidence-zip', master: { key: 'TG-TGS' } },
}

const running = {
  key: 'TG-TGS68-13',
  lifeCycleState: 'InProgress',
  plan: { key: 'TG-TGS68', shortName: 'HI-3343', master: { key: 'TG-TGS' } },
  progress: { percentageCompletedPretty: '45%', prettyTimeRemaining: '3 minutes remaining' },
}

const watch = (over: Partial<Watch> = {}): Watch => ({ sha, repo: '/r', reason: 'push', startedAt: 0, builds: [], deploys: [], ...over })

describe('bamboo logic', () => {
  test('finds the repository that a command pushes', async () => {
    expect(pushedRepo('git push', '/w/app')).toBe('/w/app')
    expect(pushedRepo('git push -u origin HEAD', '/w/app')).toBe('/w/app')
    expect(pushedRepo('cd ../other && git push', '/w/app')).toBe('/w/other')
    expect(pushedRepo('git -C /x/y push origin main', '/w')).toBe('/x/y')
    expect(pushedRepo('git commit -m "push it" && git push', '/w')).toBe('/w')
    expect(pushedRepo('git push --delete origin old', '/w')).toBe(undefined)
    expect(pushedRepo('git status', '/w')).toBe(undefined)
    expect(pushedRepo('echo git push', '/w')).toBe(undefined)
  })

  test('knows a pull request merge and reads its commit', async () => {
    const url = 'https://bitbucket.rtsprod.net/rest/api/1.0/projects/TG/repos/tgs/pull-requests/12/merge?version=3'
    expect(isMerge(`curl -s -X POST -H "Authorization: Bearer $T" "${url}"`)).toBe(true)
    expect(isMerge(`curl -s -H "Authorization: Bearer $T" "${url}"`)).toBe(false)
    expect(mergeCommit(`{"state":"MERGED","properties":{"mergeCommit":{"displayId":"39093aa41da","id":"${sha}"}}}`)).toBe(sha)
    expect(mergeCommit('{}')).toBe(undefined)
  })

  test('reads build results', async () => {
    const b = parseBuild(branchResult)
    expect(b).toEqual({
      key: 'TG-TGS68-12', planKey: 'TG-TGS68', masterKey: 'TG-TGS', branch: 'HI-3343-produce-the-final-evidence-zip',
      state: 'Successful', isFinished: true, tests: '1302 passed', failed: 0, percent: undefined, remaining: undefined,
    })
    expect(watchLine(watch({ builds: [parseBuild(running)] }))).toBe('TG-TGS68-13 running 45%, 3 minutes remaining')
    expect(watchLine(watch({ builds: [b] }))).toBe('TG-TGS68-12 passed, 1302 passed')
    expect(watchLine(watch())).toBe('39093aa4 waiting for Bamboo to start a build')
  })

  test('matches a deployment to its build', async () => {
    const results = [
      { id: 2, lifeCycleState: 'IN_PROGRESS', deploymentVersion: { items: [{ planResultKey: { key: 'TG-TGS-91' } }] } },
      { id: 1, lifeCycleState: 'FINISHED', deploymentState: 'SUCCESS', deploymentVersion: { items: [{ planResultKey: { key: 'TG-TGS-90' } }] } },
    ]
    expect(deployFor(results, 'TG-TGS-90', 'Prod')).toEqual({ id: 1, environment: 'Prod', state: 'SUCCESS', isFinished: true })
    expect(deployFor(results, 'TG-TGS-91', 'Prod')?.isFinished).toBe(false)
    expect(deployFor(results, 'TG-TGS-92', 'Prod')).toBe(undefined)
  })

  test('decides when a watch is done', async () => {
    const passed = parseBuild(branchResult)
    const failed = { ...passed, state: 'Failed', tests: '3 of 1302 failed', failed: 3 }
    expect(nextStep(watch(), 1000).outcome).toBe(undefined)
    expect(nextStep(watch(), START_WAIT_MS + 1).outcome).toContain('no build started')
    expect(nextStep(watch({ builds: [parseBuild(running)] }), 1000)).toEqual({ checkDeploys: false })
    expect(nextStep(watch({ builds: [failed] }), 1000)).toEqual({ outcome: 'TG-TGS68-12 failed, 3 of 1302 failed', isFailure: true, checkDeploys: false })
    expect(nextStep(watch({ builds: [passed], builtAt: 0 }), 1000)).toEqual({ checkDeploys: true })
    expect(nextStep(watch({ builds: [passed], builtAt: 0 }), DEPLOY_WAIT_MS + 1).outcome).toBe('TG-TGS68-12 passed, 1302 passed')
    const deploying = { id: 1, environment: 'Prod', state: 'IN_PROGRESS', isFinished: false }
    expect(nextStep(watch({ builds: [passed], deploys: [deploying] }), DEPLOY_WAIT_MS * 9)).toEqual({ checkDeploys: true })
    const deployed = { ...deploying, state: 'SUCCESS', isFinished: true }
    expect(nextStep(watch({ builds: [passed], deploys: [deployed] }), 1000).outcome).toBe('TG-TGS68-12 passed, 1302 passed, deployed to Prod')
    const broke = { ...deploying, state: 'FAILED', isFinished: true }
    expect(nextStep(watch({ builds: [passed], deploys: [broke] }), 1000).isFailure).toBe(true)
  })

  test('reads the command arguments', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs('stop')).toEqual({ kind: 'stop' })
    expect(parseArgs('watch')).toEqual({ kind: 'watch', sha: undefined })
    expect(parseArgs('watch abc1234')).toEqual({ kind: 'watch', sha: 'abc1234' })
    expect(parseArgs('watch nope!').kind).toBe('error')
  })
})
