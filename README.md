# @jeansordes/aio

A keyboard-driven terminal for agent workflows, independent validation and scripts.

## Start

Install and authenticate a Cursor Agent CLI or Codex CLI, then run in your project:

```bash
npx @jeansordes/aio
# or: bunx @jeansordes/aio
# or: npm install -g @jeansordes/aio && aio
```

The menu puts **Workflow** and **Goal** first, followed by Resume (when available),
Settings, Version, Help, Update and Quit. Use arrows and Enter, or Esc to return.
A script-only workflow does not require an agent CLI or model profile.

**Goal** asks for an objective and success criteria. Add, edit or delete criteria,
then choose **Finish criteria**. At least one criterion is required. Text entry
accepts literal `q`; quitting is a menu or execution command only. Goal builds an
action → validation → end workflow, with a correction loop back to the action.
The validator runs independently and must provide evidence for every criterion.

The first agent setup offers `low`, `mid` and `high` model profiles. Enter actual
model identifiers accepted by your chosen CLI; aio does not infer identifiers from
family names such as Luna/Sol/Astra or Haiku/Sonnet/Opus. Actions default to `mid`,
routing to `low`. Settings supports profile creation, renaming, deletion, editing
and reordering. Before **Launch**, inspect the node list and optionally change each
agent node's profile for this session.

During execution:

- Arrows inspect numbered nodes independently of the currently running node.
- The animated marker identifies execution; `>[n]<` identifies inspection.
- `f` returns inspection to the active node; PgUp/PgDn scroll its details and output.
- `p` pauses after the current invocation. Pauses offer guidance and resume.
- `q`, Ctrl+C or terminal closure stop the running process and its tools.

Execution runs only while aio is open. One session can execute per project.
The view adapts to terminal size; full events and output remain in session logs.

## Version 2 workflows

Put YAML files in `.aio/workflows/`. The package includes
[an implementation and validation workflow](examples/review.yaml) and
[a script action and routing workflow](examples/scripts.yaml).

```yaml
version: 2
name: implement-and-check
initial: implement
maxInvocations: 100
nodes:
  implement:
    type: action
    prompt: Implement TASK.md and address any prior validation findings.
    modelProfile: mid
    next: validate
  validate:
    type: route
    prompt: Independently inspect the implementation and relevant test results.
    modelProfile: low
    criteria:
      - The behavior described in TASK.md is implemented and relevant tests pass.
    routes:
      - to: implement
        description: Corrections are needed.
      - to: complete
        description: Every criterion is satisfied with evidence.
  complete:
    type: end
```

Each node may have a display `name`. Node order determines display numbers;
references in YAML continue to use stable node IDs.

An **action** has a `prompt`, `modelProfile` and `next`. It performs one invocation,
then reports `done` with a summary, or `blocked` with a summary and user request.
It does not assess its own success criteria. Prior routing findings are included
in subsequent action prompts.

A **route** has a `prompt`, `modelProfile`, and authorized `routes` with `to` and
`description`. It reports a destination and justification, or asks the user for
help. Optional `criteria` require one `{status, evidence}` entry per criterion:
`satisfied`, `not_satisfied`, or `indeterminate`. Only all-satisfied results may
route directly to an end. Indeterminate results require a blocked report with a
user request. The prompt prohibits editing project work; this is an instruction
boundary, not a universal read-only OS sandbox.

An **end** completes execution without launching a process.

A **script** declares `command`, `args` and exactly one of `next` or `routes`.
It runs from the project directory, with the environment inherited from aio and
no implicit shell. Use `node`, `python3`, or another interpreter explicitly.

```yaml
type: script
command: node
args: [scripts/check.js]
timeoutMs: 600000
routes:
  - to: implement
    description: Corrections are required.
  - to: complete
    description: The checks pass.
```

For a fixed `next`, exit code 0 advances and stdout/stderr are logs. A routing script
must exit 0 and print a single JSON object such as
`{"to":"complete","summary":"All checks passed"}` to stdout; put diagnostic logs
on stderr. Unexpected exits, invalid destinations, invalid/oversized JSON (64 KiB)
and timeouts pause for the user. Scripts never trigger model fallback. The timeout
defaults to ten minutes and is configurable with `timeoutMs`.

Every launched agent or script counts against `maxInvocations` (default 100),
including failed fallback attempts. At the limit aio pauses. Explicit resume
starts a fresh execution window. Cycles must have an eventual path to an end.

## Global CLI configuration and model profiles

Harness definitions and notifications live in `$XDG_CONFIG_HOME/aio/config.yaml`,
or `~/.config/aio/config.yaml` when the variable is unset or relative. Cursor and
Codex are built in; their CLIs own authentication. Custom harnesses are supported:

```yaml
harnesses:
  custom:
    command: /absolute/path/to/your-cli
    args: ["--print", "{{model_args}}", "{{prompt}}"]
    modelArgs: ["--model", "{{model}}"]
```

Custom CLIs must run headlessly and write the requested report file. Use their
actual arguments. For stdin prompts, set `promptInput: stdin` and add the CLI's
required stdin flag to `args`. Templates are `{{prompt}}`, `{{project_root}}`,
`{{model}}` and the standalone `{{model_args}}` expansion. Optional
`successExitCodes` defaults to `[0]`. Relative executable paths resolve from the
global configuration directory.

`model-profiles.yaml` lives in that same global directory. Each name maps directly
to an ordered list of explicit harness/model pairs. These identifiers are examples
to replace with ones accepted by your CLIs:

```yaml
profiles:
  low:
    - harness: codex
      model: your-lightweight-model-id
  mid:
    - harness: codex
      model: your-primary-model-id
    - harness: cursor
      model: your-fallback-model-id
  high:
    - harness: codex
      model: your-advanced-model-id
```

The first entry has priority. Missing executables are skipped. Recognized
model-unavailable, exhausted-quota or rate-limit failures try the next entry;
unknown errors or invalid agent reports pause. Failure classification uses process
failure diagnostics, not model prose claiming a quota problem. A CLI that hides
its failure reason may require manual intervention. No universal quota lookup or
automatic model discovery is assumed.

Unavailable pairs are excluded for the current execution window and reconsidered
on explicit resume. A fallback stops the old process group, retains partial edits,
and instructs the next agent to inspect the actual project before continuing.
Selection and fallback events record profile, entry number, harness, requested
model and reason. Requested models are never presented as confirmed actual models.
When every entry is unavailable, aio pauses.

Workflow nodes use `modelProfile` only. Settings renames do not rewrite project
workflows; update their references separately. Session profile changes made before
launch do not edit the source YAML.

## Notifications

Configure optional notifications once in the same global config file; they
apply to sessions in every project. The default events are `paused` and
`completed`. You can also request `started` and `resumed`.

```yaml
notifications:
  events: [paused, completed]
  timeoutMs: 3000
  targets:
    - name: phone
      type: ntfy
      url: ${AIO_NTFY_URL}
    - name: discord
      type: discord
      url: ${AIO_DISCORD_WEBHOOK}
    - name: pushover
      type: pushover
      token: ${AIO_PUSHOVER_TOKEN}
      user: ${AIO_PUSHOVER_USER}
    - name: generic
      type: webhook
      url: ${AIO_WEBHOOK_URL}
      headers:
        Authorization: "Bearer ${AIO_WEBHOOK_TOKEN}"
```

Remove destinations you do not use and provide the referenced environment
variables when starting aio. ntfy expects a topic URL; Pushover needs an
application token and a user key. The generic webhook receives JSON containing
`event`, `timestamp`, `machine`, `project`, `workflow`, `node`,
`title` and `message`. The message can include the pause reason or a short
result; full prompts and transcripts are not sent.

Delivery errors are displayed and recorded without stopping the workflow.
Requests have bounded timeouts and are not retried automatically. Acceptance
by the service does not establish that a notification reached your device.

## Persistence and compatibility

`.aio/sessions/current/session.json` contains the version 2 workflow, referenced
profiles, concrete CLI definitions, position, guidance and result history.
`events.jsonl` and `conversation.log` preserve full execution logs. Session data
is ignored by Git. Resume uses its snapshot even if workflow or profile files change.

Accepted results and transitions are saved atomically. Interrupted attempts may
have changed files even though no result was accepted. Starting a new session
archives the previous directory under `.aio/sessions/archive-*`; it does not delete
its results or logs. A stale lock after a forced kill requires checking that the old
aio and agent processes stopped before removing `.aio/sessions/lock`.

This is a breaking format change. Legacy goal nodes, old sessions, `defaultHarness`,
`defaultModel` and per-node concrete harness/model overrides are unsupported. Create
new version 2 definitions and configure profiles; remove obsolete global defaults
from `config.yaml`. Old sessions are reported in the menu and archived on the next
launch. No automatic conversion or legacy execution engine is provided.

Criterion evidence is reported by the independent routing agent. Aio validates its
report structure and completion gate; it does not independently prove qualitative
claims. For deterministic checks, use scripts.

## Commands and development

`aio --help` shows usage; `aio --version` shows installation details.
`aio update` updates supported global installations. Set
`AIO_NO_UPDATE_CHECK=1` to disable startup update checks.

From this repository:

```bash
npm ci
npm test
./dev-bin/daio
```
