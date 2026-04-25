# `@jeansordes/aio`

Jean Sordes's AI Orchestrator CLI.

`aio` is currently under construction. The package is published so you can
install and run the CLI entrypoint while the full orchestration experience is
being built.

## Run

```bash
npx @jeansordes/aio
```

```bash
bunx @jeansordes/aio
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

For now, the command prints:

```text
Hi! Welcome to Jean Sordes's AI Orchestrator, a tool for orchestrating AI agents in coding project. The project is currently under construction, stay tuned !
```

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
