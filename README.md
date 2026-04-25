# `@jeansordes/aio`

Jean Sordes's AI Orchestrator CLI.

`aio` scaffolds a project-local `.aio/` tree and runs YAML-defined workflows
through replaceable provider wrapper scripts.

## Run

```bash
npx @jeansordes/aio
```

```bash
bunx @jeansordes/aio
```

Initialize a project:

```bash
npx @jeansordes/aio init
```

Re-run setup idempotently:

```bash
npx @jeansordes/aio setup
```

Run the default workflow:

```bash
npx @jeansordes/aio run
```

Run a named workflow from `.aio/workflows/<name>.yaml`:

```bash
npx @jeansordes/aio run release
```

This repository also ships a custom `roadmap-step` workflow (see
`.aio/workflows/roadmap-step.yaml`) for executing one tracked roadmap item at a
time with `aio run roadmap-step` once `cursor-agent` is available.

Check for a newer package version and update a supported global install:

```bash
aio update
```

## Install Globally

With npm:

```bash
npm install -g @jeansordes/aio
aio
```

With Bun:

```bash
bun add -g @jeansordes/aio
aio
```

## Current Behavior

With no subcommand, or with `help`, `-h`, or `--help` as the first argument, the
CLI prints the same man-style help (sectioned `NAME`, `SYNOPSIS`, `DESCRIPTION`,
`COMMANDS`, `EXAMPLES`, `VERSION`). So `aio`, `aio help`, `aio -h`, and `aio
--help` are equivalent.

`aio init` and `aio setup` create project-local orchestration files.

During init, `config.yaml` records a `tracking.file` for your task or roadmap
tracker. In interactive shells you are prompted: accept a detected default
(`specs/roadmap.csv`, `TASKS.md`, or `ROADMAP.md` in that order), type another
path, use `s` to scaffold the optional `specs/` layout (including
`specs/roadmap.csv`), or `n` for no file. In non-interactive runs (for example
CI) init auto-detects those same paths; it does not create `specs/`.

The generated `providers/cursor.sh` uses the
[Cursor Agent CLI](https://cursor.com/docs/cli) (`cursor-agent` on your
`PATH`, non-interactive `print` mode) so workflows can run without editing that
file first. Set `CURSOR_API_KEY` in the environment (see Cursor docs) so the
CLI can authenticate. Other provider wrappers are still placeholders until you
replace them.

```text
.aio/
  config.yaml
  providers/
    cursor.sh
    codex.sh
    claude.sh
    gemini.sh
    opencode.sh
    custom.sh
  roles/
    analyse.yaml
    plan.yaml
    build.yaml
    review.yaml
    fix.yaml
    log.yaml
    commit.yaml
    publish.yaml
  workflows/
    default.yaml
  prompts/
  schemas/
```

Setup never overwrites existing files.

Provider wrappers read a standard JSON request on stdin and write normalized
JSON on stdout. The generated `cursor` wrapper calls `cursor-agent` as
described above. The other provider scripts are placeholders that return a
clear `not_configured` result until you edit them to call Codex, Claude, Gemini,
OpenCode, or a custom tool.

Workflow execution loads `.aio/workflows/default.yaml` for `aio run` or a named
workflow for `aio run <workflow>`. It starts at `initial`, executes each state's
role through the configured provider wrapper, follows direct or simple
conditional transitions, and stops at `type: final`.

When installed globally, `aio` checks whether a newer version is available. If
there is one, it asks before updating itself.

Package-manager one-off runs such as `npx @jeansordes/aio` and
`bunx @jeansordes/aio` do not self-update.

`aio update` is the explicit update command. It checks the latest published
package version and immediately updates global npm or Bun installs. For npx,
bunx, local, or unknown invocations, it prints manual install guidance instead
of mutating an unrelated environment.

## Requirements

Use a current Node.js runtime. The published package is tested with Node.js 22.

## Package

The npm package is:

```text
@jeansordes/aio
```

Project releases are listed in
[CHANGELOG.md](https://github.com/jeansordes/aio/blob/main/CHANGELOG.md).
