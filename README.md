# `@jeansordes/aio`

[![npm](https://img.shields.io/npm/v/@jeansordes/aio.svg)](https://www.npmjs.com/package/@jeansordes/aio)
[![Node](https://img.shields.io/node/v/@jeansordes/aio.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Project-local AI orchestration. Declarative YAML workflows wired to the CLI you
already use.

## What is aio?

`aio` scaffolds a `.aio/` directory in your repo and runs **YAML-defined
workflows**. Each step invokes a **role** through a **provider**. The default
template targets the [Cursor Agent CLI](https://cursor.com/docs/cli)
(`cursor-agent` on your `PATH`). Providers live in `providers.yaml`, so you can
swap or extend CLIs without rewriting workflows.

Workflow progress comes from **process exit codes and working-tree changes**, not
from parsing model JSON. Agents coordinate through **project files** (code, specs,
roadmap rows), so handoffs stay inspectable and versionable.

## Why it is useful

- **Repeatable runs:** encode how each agent step is invoked once, then run the
  same graph with `aio run` or `aio run <workflow>`.
- **Execution is data:** change command, args, or isolation in YAML; roles and
  workflows stay stable.
- **Orchestration stays in `.aio/`:** product knowledge (specs, roadmap, tasks)
  stays where you put it; init can record a tracking file and pass it into
  provider prompts.

## Quick start

Set `CURSOR_API_KEY` as described in the Cursor docs, then:

```bash
npx @jeansordes/aio init
npx @jeansordes/aio run
```

Use `bunx @jeansordes/aio` instead of `npx` if you prefer Bun.

The generated `.aio/providers.yaml` configures `cursor-agent` for non-interactive
use. Other named providers in that file ship as `not_configured` until you edit
them.

## Example workflow

The [`templates/roadmap-step/`](templates/roadmap-step/) template defines a
small state machine: pick a roadmap row, implement, test, optionally fix, commit,
then finish. The workflow file looks like this:

```yaml
name: roadmap-step
initial: pickRow
states:
  pickRow:
    role: pick-row
    next:
      - if: step.status == "ok"
        then: implement
      - then: done
  implement:
    role: implement
    next: test
  test:
    role: test
    next:
      - if: step.exit_code == 0
        then: commit
      - then: fix
  fix:
    role: fix
    next: test
  commit:
    role: commit
    next: done
  done:
    type: final
```

## Providers

Roles call whichever provider they declare. The default **cursor** provider in a
new project matches the template:

```yaml
providers:
  cursor:
    command: cursor-agent
    args:
      - "-p"
      - "--force"
      - "--trust"
      - "--output-format"
      - "stream-json"
      - "--stream-partial-output"
      - "{{isolation_args}}"
      - "{{model_args}}"
      - "{{prompt}}"
    isolationArgs:
      - "--workspace"
      - "{{project_root}}"
      - "--sandbox"
      - "enabled"
    modelArgs:
      - "--model"
      - "{{model}}"
    prompt:
      include:
        - instructions
        - tracking_file
        - context_files
    success:
      exit_codes: [0]
```

Additional provider slots (`codex`, `claude`, `gemini`, `opencode`, `custom`) are
`not_configured` stubs until you fill them in. Provider entries define command,
arguments, how the prompt is built, and which exit codes count as success.
`aio` treats stdout and stderr as logs; workflow decisions use exit codes and
repo state, not parsed AI JSON.

## `.aio/` layout

After `init`, a typical tree looks like this:

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
    summarize.yaml
  workflows/
    default.yaml
  prompts/
  schemas/
```

Default **roles** (each is instructions plus provider context for one step):

- **analyse:** summarize the repo and what work is needed.
- **plan:** turn that into a concise implementation plan.
- **build:** apply the planned change in the working tree.
- **review:** review the result; edit only if something must be fixed.
- **fix:** address review findings.
- **log:** record outcome when review does not lead to commit.
- **commit:** create a commit when the tree is ready.
- **publish:** follow your release or publish steps.
- **summarize:** write a short summary from the latest run log under `.aio/runs/`.

`setup` (same as `init`) never overwrites existing files.

During **init**, `config.yaml` can record a `tracking.file` for your task or
roadmap tracker. In an interactive shell you get a short prompt: **Enter** keeps
the first detected file among `specs/roadmap.csv`, `TASKS.md`, and `ROADMAP.md`,
or, if none exist, scaffolds the optional `specs/` layout (including
`specs/roadmap.csv`) as the default. You can type another path, **`s`** to
scaffold `specs/` explicitly, or **`n`** for no file. In non-interactive runs
(for example CI) init auto-detects those paths and does not create `specs/`.

Optional **Discord** notification settings from interactive init can be merged
into a gitignored `.aio/.env`; the template ships `.gitignore` rules under
`.aio/` so secrets are not committed.

## CLI reference

- **`aio`**, **`aio help`**, **`aio -h`**, **`aio --help`:** print man-style help
  (`NAME`, `SYNOPSIS`, `DESCRIPTION`, `COMMANDS`, `EXAMPLES`, `VERSION`).
- **`aio version`**, **`aio --version`**, **`aio -v`:** print package version and
  install context.
- **`aio init`**, **`aio setup`:** create or refresh `.aio/`; existing files are
  not overwritten (`setup` is a synonym for `init`).
- **`aio run`:** run `.aio/workflows/default.yaml`. **`aio run <workflow>`:**
  run `.aio/workflows/<workflow>.yaml`. Supports loop counts, `--quiet` /
  `--verbose`, and **`--allow-edits-outside-dir`** to disable project-directory
  isolation for the Cursor provider (a warning is printed). Each run writes
  logs under `.aio/runs/<id>/`; the latest id is stored in `.aio/runs/latest`.
- **`aio observe`:** follow the conversation log for the latest run (like
  `tail -f`). Use **`--events`** for `events.jsonl`, **`--run <id>`** for a
  specific run directory.
- **`aio update`:** check the registry and upgrade a detected global npm, pnpm,
  or Bun install, or print manual install commands for other contexts.

## Updates

For installs `aio` recognizes as a **global npm, pnpm, or Bun** copy, a normal
command may compare your version to the registry, prompt on a TTY, and run the
matching installer if you accept.

`npx @jeansordes/aio` and `bunx @jeansordes/aio` do **not** self-update. If a
newer version exists but `aio` cannot run an installer (npx, bunx, an
unrecognized path, or `unknown`), it may print a short notice to stderr with
`npm` / `pnpm` / `bun` one-liners. Set **`AIO_NO_UPDATE_CHECK=1`** to skip
registry checks and those notices on normal commands (for example in CI). The
**`aio update`** subcommand still contacts the registry when you run it
explicitly.

**`aio update`** fetches the latest version and, when possible, updates a
detected global npm, pnpm, or Bun install. For npx, bunx, local, or other
unsupported contexts it prints manual install commands instead of changing an
unrelated environment.

## Templates

- **[`templates/roadmap-step/`](templates/roadmap-step/):** copy
  `workflows/roadmap-step.yaml` and the matching files under `roles/` into a
  target project's `.aio/`, then run **`aio run roadmap-step`** once
  `cursor-agent` is available.
- **[`templates/debug-introspect/`](templates/debug-introspect/):** minimal
  read-only workflow (`introspect`) for checking what the provider sees and would
  do. Copy `workflows/introspect.yaml` and `roles/introspect.yaml` into `.aio/`,
  then run **`aio run introspect`**.

## Install globally

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

## Requirements

Use a current Node.js runtime. The published package is tested with Node.js 22.

## Changelog

Releases are listed in
[CHANGELOG.md](https://github.com/jeansordes/aio/blob/main/CHANGELOG.md).
