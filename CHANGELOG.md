## [0.11.0](https://github.com/jeansordes/aio/compare/v0.10.0...v0.11.0) (2026-04-28)

### Features

* **cli:** `aio run` supports loop counts (`aio run 3`, `aio run wf 5`, `aio run 0`, `--loops` / `-n`), two-stage SIGINT (finish loop vs abort provider), `--allow-edits-outside-dir`, and `--verbose` NDJSON on stderr for stream-json providers ([`03.03.01`](specs/02-requirements/03.03.01-limit-workflow-loops.md), [`03.03.03`](specs/02-requirements/03.03.03-stream-runtime-logs.md)).
* **orchestration:** per-provider `isolationArgs` with `{{isolation_args}}` / `{{project_root}}`, `GIT_CEILING_DIRECTORIES` for provider children, empty `AGENTS.md` on init when nested ([`03.00.06`](specs/02-requirements/03.00.06-scope-provider-to-project-root.md)).
* **term-sink:** render Cursor `stream-json` / `--stream-partial-output` in the terminal; heartbeat uses exponential backoff and elapsed seconds.

### BREAKING CHANGE

* Workflow YAML **`summary`** / **`summary.enabled`** no longer runs a second provider call after a step. Use a normal state (the default template adds `summarize` after `publish`) and optional `run_dir` in the role’s `prompt.include` ([`03.03.05`](specs/02-requirements/03.03.05-per-state-ai-summary.md)).

## [0.10.0](https://github.com/jeansordes/aio/compare/v0.7.0...v0.10.0) (2026-04-27)

### Features

* **orchestration:** stream runs, observe, Discord, and inquirer init ([5b91531](https://github.com/jeansordes/aio/commit/5b91531f1fd5dfa59d9f6934d971794a60c74497))
* **setup:** versioned default template, dev daio, declarative providers ([433da08](https://github.com/jeansordes/aio/commit/433da083f14b269b6e556cf8ee6dbf09ee636518))

## [0.7.0](https://github.com/jeansordes/aio/compare/v0.6.0...v0.7.0) (2026-04-27)

### Features

* **setup:** add guided init UI and default spec roadmap when untracked ([db6002d](https://github.com/jeansordes/aio/commit/db6002df9c8428a8e815de0299aa4c4391f3a5f6))

### Bug Fixes

* **detect:** treat symlinked aio in Bun global bin as global-bun ([e9e2473](https://github.com/jeansordes/aio/commit/e9e2473b111df63687d4f3b1e33a3d2a13b95fb7))

## [0.6.0](https://github.com/jeansordes/aio/compare/v0.5.0...v0.6.0) (2026-04-27)

### Features

* **workflow:** validate config and improve runtime diagnostics ([5973b0a](https://github.com/jeansordes/aio/commit/5973b0aeb7d52b5334cf3f27523a7d742cbecc4c))

## [0.5.0](https://github.com/jeansordes/aio/compare/v0.4.0...v0.5.0) (2026-04-25)

### Features

* **cli:** harden update detection, pnpm, and passive notices ([fae2939](https://github.com/jeansordes/aio/commit/fae2939afb67ac77d80ec96e363b980ffded3abc))

## [0.4.0](https://github.com/jeansordes/aio/compare/v0.3.1...v0.4.0) (2026-04-25)

### Features

* **setup:** tracking file, cursor-agent provider, projectKnowledge ([ad6558e](https://github.com/jeansordes/aio/commit/ad6558e07e0f2394f97d24c6cbeeb60efe68759f))

## [0.3.1](https://github.com/jeansordes/aio/compare/v0.3.0...v0.3.1) (2026-04-25)

### Bug Fixes

* **cli:** man-style help; unify aio, help, -h, and --help ([b219758](https://github.com/jeansordes/aio/commit/b21975824e47e3695f43ee070888aeda946b9e72))

## [0.3.0](https://github.com/jeansordes/aio/compare/v0.2.0...v0.3.0) (2026-04-25)

### Features

* **update:** add explicit package update command ([d1264b1](https://github.com/jeansordes/aio/commit/d1264b1f0c9c5d57d7e53f93b3bafdb3367ff374))

## [0.2.0](https://github.com/jeansordes/aio/compare/v0.1.0...v0.2.0) (2026-04-25)

### Features

* **orchestration:** add project setup and workflow runner ([a307ef6](https://github.com/jeansordes/aio/commit/a307ef6fd95bd344703bac03a79a785fa4eabb08))

## [0.1.0](https://github.com/jeansordes/aio/compare/189de22eba016eb382d1d932e95a1a9418ab681f...v0.1.0) (2026-04-25)

### Features

* scaffold aio cli and release workflow ([189de22](https://github.com/jeansordes/aio/commit/189de22eba016eb382d1d932e95a1a9418ab681f))
