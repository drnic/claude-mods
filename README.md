# claude-mods

Mods for Claude Code. A mod is a plugin of JavaScript or TypeScript hooks that runs inside Claude Code. Mods need Claude Code v2.1.287 or later. See the [mods overview](https://code.claude.com/docs/en/plugins/mods/overview).

## Install

Add this folder as a marketplace, then install the mods you want:

```bash
claude plugin marketplace add ~/Projects/claude-mods
claude plugin install phase@claude-mods
claude plugin install bang@claude-mods
```

Claude Code reads a local marketplace from its folder. After you edit a mod, run `/reload-plugins` in a session. You do not need to reinstall.

To install from a clone on another machine, give the clone's path or the git URL to `claude plugin marketplace add`.

## Mods

### phase

`phase` runs a plan document one phase at a time. It replaces `bin/ralph` in `verra-worktrees`.

```
/phase                    show the plan, the auto run and the context fill
/phase next [fresh|keep]  run the next phase now
/phase auto N             run N phases, one after another
/phase stop               stop the auto run after the current phase
/phase plan <path>        set the plan for this folder
/phase threshold <pct>    clear the context first at or above this fill
```

If you do not set a plan, the mod looks in `mydocs/` for one `<TICKET>-*-plan.md` file that matches the ticket at the start of the branch name.

Before each phase, the mod runs `git push`. If the context is at or above the threshold (default 40%), the mod runs `/clear`. If `/clear` fails, it compacts the context. Then it sends a prompt that tells Claude to do the next step, commit and push.

An auto run stops when a phase makes no commit, leaves uncommitted changes, does not push, or replies `ALL PHASES DONE`. It also stops when you interrupt a phase.

### bang

`bang` lets a Remote Control client, such as the Claude iOS app, run shell commands on the machine. The terminal has `!` for this, but Remote Control does not.

```
! git status        sent from the phone: runs the command
/run                runs the last `! command` that Claude suggested
/run <command>      runs <command>
```

The output goes into the transcript, and Claude reads it. Commands run with `zsh -lc` in the session folder. They get no keyboard input and stop after 10 minutes. A command that waits for input, such as `gcloud auth login`, fails at once.

`/run` runs only when you send it, from the terminal or from Remote Control. Claude cannot start it.

## Develop

Each mod is a folder under `mods/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.ts`. Pure logic goes in `hooks/logic.ts`, with tests in `hooks/logic.test.ts`.

```bash
claude plugin validate mods/phase
claude plugin test mods/phase
```

To add a mod, create its folder and add an entry to `.claude-plugin/marketplace.json`.
