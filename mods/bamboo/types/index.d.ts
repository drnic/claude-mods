export type Build = {
  key: string
  planKey: string
  // The plan the deployment projects hang off: the master plan for a branch plan.
  masterKey: string
  branch: string
  state: 'Successful' | 'Failed' | 'Unknown' | string
  isFinished: boolean
  tests?: string
  failed: number
  percent?: string
  remaining?: string
}

export type Deploy = {
  id: number
  environment: string
  state: string
  isFinished: boolean
}

export type Watch = {
  sha: string
  repo: string
  // What started it: "push", "merge" or "command".
  reason: string
  startedAt: number
  builds: Build[]
  deploys: Deploy[]
  // When the last build finished, to stop waiting for a deployment that never starts.
  builtAt?: number
  outcome?: string
  isFailure?: boolean
  finishedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    bamboo: { watches: Watch[] }
  }
}
