# `@jeansordes/aio`

Jean Sordes's AI Orchestrator CLI.

`aio` scaffolds a project-local `.aio/` tree and runs YAML-defined workflows
through replaceable provider CLI configuration.

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

This repository also ships a `roadmap-step` workflow template (see
[`templates/roadmap-step/`](templates/roadmap-step/)) for executing one tracked
roadmap item at a time. Copy `workflows/roadmap-step.yaml` and the matching role
files under `roles/` into a target project's `.aio/` to use
`aio run roadmap-step` once `cursor-agent` is available.

## Develop this repo (daio)

`daio` runs the **clone** in this directory so you can try changes without
publishing, without replacing your globally installed `aio`. Add
[`dev-bin/`](dev-bin) to your `PATH` (or symlink `dev-bin/daio` to a directory
on your `PATH`):

```bash
export PATH="/path/to/aio/dev-bin:$PATH"
```

`daio` sets `AIO_NO_UPDATE_CHECK=1` and invokes `bin/aio.js` from the repo root.
If `dev-bin/daio` is not marked executable in your environment, run
`chmod +x dev-bin/daio` once, or call `sh dev-bin/daio` instead of `daio`.
Run manual checks with real projects under the ignored `sandbox/` folder (for
example `sandbox/manual-cli/`) so the repository root never holds a
project-local `.aio/` tree.

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
tracker. In interactive shells you get a short guided prompt: **Enter** keeps
the first detected file among `specs/roadmap.csv`, `TASKS.md`, and `ROADMAP.md`,
or—if none exist—scaffolds the optional `specs/` layout (including
`specs/roadmap.csv`) as the default. You can still type another path, **`s`** to
scaffold `specs/` explicitly, or **`n`** for no file. In non-interactive runs
(for example CI) init auto-detects those same paths; it does not create `specs/`.

The generated `.aio/providers.yaml` configures the
[Cursor Agent CLI](https://cursor.com/docs/cli) (`cursor-agent` on your
`PATH`, non-interactive `print` mode) so workflows can run without provider
scripts. Set `CURSOR_API_KEY` in the environment (see Cursor docs) so the CLI
can authenticate. Other providers are `not_configured` entries until you edit
the YAML.

```text
.aio/
  config.yaml
  providers.yaml
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

Provider entries define the command, arguments, prompt placement, and success
exit codes for each external AI CLI. `aio` captures stdout and stderr as logs
only; workflow state is derived from the process exit code and working-tree
changes. Agents share durable state through project files, not through another
agent's transcript or parsed AI JSON.

Workflow execution loads `.aio/workflows/default.yaml` for `aio run` or a named
workflow for `aio run <workflow>`. It starts at `initial`, executes each state's
role through the configured provider, follows direct or simple conditional
transitions, and stops at `type: final`.

For installs aio recognizes as a **global npm, pnpm, or Bun** copy (it walks
the running script and global paths), a normal `aio` command may compare your
version to the registry, prompt on a TTY, and then run the matching installer
if you accept.

`npx @jeansordes/aio` and `bunx @jeansordes/aio` do not self-update. If a newer
version is published and aio cannot run an installer (for example, npx, bunx, an
unrecognized path, or `unknown`), a short notice may be printed to stderr with
`npm` / `pnpm` / `bun` one-liners. Set `AIO_NO_UPDATE_CHECK=1` to skip these
registry checks and notices on normal commands (for example in CI). The
`aio update` subcommand still checks the registry when you run it explicitly.

`aio update` is the explicit update command. It fetches the latest version and,
when possible, immediately updates a detected global npm, pnpm, or Bun
install. For npx, bunx, local, or other unsupported contexts, it prints manual
install commands instead of changing an unrelated environment.

## Requirements

Use a current Node.js runtime. The published package is tested with Node.js 22.

## Package

The npm package is:

```text
@jeansordes/aio
```

Project releases are listed in
[CHANGELOG.md](https://github.com/jeansordes/aio/blob/main/CHANGELOG.md).
