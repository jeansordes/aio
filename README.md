# `@jeansordes/aio`

Jean Sordes's AI Orchestrator CLI.

`aio` is currently under construction. The package now includes the first
runnable orchestration slice: project setup plus YAML-driven workflow execution
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

With no command, the CLI still prints:

```text
Hi! Welcome to Jean Sordes's AI Orchestrator, a tool for orchestrating AI agents in coding project. The project is currently under construction, stay tuned !
```

`aio init` and `aio setup` create project-local orchestration files:

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

Setup never overwrites existing files. In interactive terminals it also asks
whether to scaffold this repository's optional `specs/` roadmap structure. In
non-interactive runs it does not create `specs/`.

Provider wrappers read a standard JSON request on stdin and write normalized
JSON on stdout. The generated wrappers are placeholders that return a clear
`not_configured` result until you edit them to call Cursor, Codex, Claude,
Gemini, OpenCode, or a custom tool.

Workflow execution loads `.aio/workflows/default.yaml` for `aio run` or a named
workflow for `aio run <workflow>`. It starts at `initial`, executes each state's
role through the configured provider wrapper, follows direct or simple
conditional transitions, and stops at `type: final`.

When installed globally, `aio` checks whether a newer version is available. If
there is one, it asks before updating itself.

Package-manager one-off runs such as `npx @jeansordes/aio` and
`bunx @jeansordes/aio` do not self-update.

## Requirements

Use a current Node.js runtime. The published package is tested with Node.js 22.

## Package

The npm package is:

```text
@jeansordes/aio
```

Project releases are listed in
[CHANGELOG.md](https://github.com/jeansordes/aio/blob/main/CHANGELOG.md).
