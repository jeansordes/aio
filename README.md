# @jeansordes/aio

An interactive terminal for Goals and agent-routed workflows.

Run `aio` in your project directory. Choose a standalone Goal, select a YAML
workflow, or resume saved work. The terminal shows an ASCII graph, the active
node and recent agent output.

## Start

Install an authenticated Cursor Agent CLI or Codex CLI, then run:

```bash
npx @jeansordes/aio
```

You can also use `bunx @jeansordes/aio`, or install globally:

```bash
npm install -g @jeansordes/aio
aio
```

On first use, choose the default harness. For a standalone Goal, enter an
objective and one success criterion per line, then an empty line.

- `p` then Enter pauses after the current invocation.
- At a pause, press Enter to resume, or enter guidance for the agent.
- `q` then Enter or Ctrl+C stops the harness and its tools.
- Reopen `aio` in the same directory to resume the saved checkpoint.

Execution runs only while aio is open. One session can execute per project.
After an interruption, project files may include changes from the unfinished
invocation even though its result has not been accepted.

## Workflows

Put YAML files in `.aio/workflows/` to make them available in the menu.
The package includes [an implementation/review example](examples/review.yaml).

A workflow defines `name`, `initial`, `nodes` and an optional `maxInvocations`.
Objectives belong to Goal nodes, not to the workflow.

```yaml
name: implement-and-check
initial: implement
nodes:
  implement:
    type: goal
    objective: Implement the behavior described in TASK.md.
    criteria:
      - The behavior is implemented and relevant tests pass.
    next: decide

  decide:
    type: route
    instructions: Inspect the implementation and its test evidence.
    routes:
      - to: implement
        description: Corrections are needed.
      - to: complete
        description: The implementation satisfies the requested behavior.

  complete:
    type: end
```

A **Goal** owns `objective`, nonempty `criteria`, and `next`. It can also
define `instructions` and `maxTurns`. The agent works in fresh invocations
until it reports success with evidence for every criterion. Incomplete work
continues in the same node. When it needs your intervention, aio pauses and
shows its request.

A **Route** owns `instructions` and a list of `routes`, each with `to` and
`description`. Its agent chooses an allowed destination and gives a reason.
It may inspect files; its instructions prohibit performing the Goals' work.
This is an instruction boundary, not a universal read-only sandbox.

An **End** node completes execution without invoking an agent.

Agent nodes may set `harness` and `model`. A Goal revisited through a cycle
starts a fresh visit with the previous results available. The standalone Goal
uses this same runtime with a Goal node followed by an End.

By default, aio pauses after ten invocations of the current Goal or one hundred
invocations across the workflow. Set `maxTurns` on a Goal or `maxInvocations`
on the workflow to change these limits. Resuming explicitly resets these
execution-window limits. A limit prompts you to review progress; it does not
declare the task blocked or complete.

## Global harness settings

Settings live in `$XDG_CONFIG_HOME/aio/config.yaml`, or
`~/.config/aio/config.yaml` when the variable is unset or relative.
Cursor and Codex have built-in adapters. Authentication is handled by their CLIs.

```yaml
defaultHarness: codex
# defaultModel: your-model

harnesses:
  custom:
    command: /absolute/path/to/your-cli
    args:
      - "--print"
      - "{{model_args}}"
      - "{{prompt}}"
    modelArgs:
      - "--model"
      - "{{model}}"
```

A custom harness must run headlessly in the project directory and be able to
write the requested JSON report file. Use the CLI's actual supported arguments.
For a harness that reads the prompt from stdin, set `promptInput: stdin` and
supply any stdin flag that CLI requires in `args`.

Argument templates support `{{prompt}}`, `{{project_root}}` and `{{model}}`.
The standalone `{{model_args}}` entry expands the configured model arguments
when a model is selected. Optional `successExitCodes` defaults to `[0]`.
Relative command paths resolve from the global config directory.

Node harness choices override the global default. Model precedence is:
node `model`, the selected harness's `model`, then global `defaultModel`.
Missing or unavailable harnesses pause execution rather than substituting
another agent. Every project uses this global configuration.

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

## Persistence and evidence

The current workflow snapshot, defaults, node position, guidance and full
result history live in `.aio/sessions/current/session.json`. The directory
also contains `events.jsonl` and `conversation.log`; sessions are ignored by Git.
Resume uses the saved workflow even if the source YAML has changed.

A successful process exit alone does not establish completion. aio accepts
only a valid report for the current invocation and displays the evidence
reported by the agent. It does not independently prove qualitative criteria.

Each accepted result and next position are saved atomically. New sessions
replace the current session and its logs. After a forced process kill, check
that the old aio and harness processes have stopped before removing a stale
`.aio/sessions/lock`.

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
