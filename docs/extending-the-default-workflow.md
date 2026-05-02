# Extending the default aio workflow

This document lives in the **aio repository** only. `aio init` does not copy it
into your project.

The default template (`templates/default-workflow/`) ships a minimal loop:

**pick → do → eval → (done | pick)**.

- **pick** — reads `tracking.file` from `.aio/config.yaml` (for example
  `specs/roadmap.csv`, `TASKS.md`, or `ROADMAP.md` when you configure it) and
  records the chosen task in **`state.json`** under `.aio/runs/<runId>/`.
- **do** — implements that task in the repo.
- **eval** — decides completion. It exits **0** when the task is done (workflow
  goes to `done`), or **non-zero** to loop back to **pick**. It updates
  `state.json` (including `iteration` and `notes`) so the next cycle has
  concrete feedback.

Transitions use the normal workflow syntax: `next:` with `if:` on
`step.exit_code`, `step.status`, `step.has_changes`, etc. (see
[`specs/02-requirements/03.02.02-workflows-support-linear-and-conditional-transitions.md`](../specs/02-requirements/03.02.02-workflows-support-linear-and-conditional-transitions.md)).

A hard cap on how many **states** run in one **`aio run`** is
`workflow.maxSteps` in `.aio/config.yaml`.

**Future:** aggregate “should we stop after `done`?” criteria across the whole
invocation may be added as [`03.03.07`](../specs/02-requirements/03.03.07-post-done-stop-evaluator.md)
(post-done stop evaluator). Until then, all repetition is inside one workflow
graph.

---

## Example `state.json`

```json
{
  "task": { "id": "example-1", "title": "Fix login bug", "source": "TASKS.md" },
  "iteration": 2,
  "status": "continue",
  "notes": "Add unit test for expired token; tests still red."
}
```

---

## Legacy roles (reference snippets)

These roles matched an older default template. Copy the YAML into `.aio/roles/` and wire them in `.aio/workflows/default.yaml` (or another
workflow) when you need them.

### analyse

Summarize the repo and what work is needed.

```yaml
provider: cursor
model: default
instructions: "Analyse the current project state and summarize the work needed."
contextFiles: []
```

### plan

Turn analysis into a concise implementation plan.

```yaml
provider: cursor
model: default
instructions: "Create a concise implementation plan from the analysis."
contextFiles: []
```

### build

Implement the planned change (same intent as **do** in the new default).

```yaml
provider: cursor
model: default
instructions: "Implement the planned change in the working tree."
contextFiles: []
```

### review

Review the result; route on provider status, changes, and exit code.

```yaml
provider: cursor
model: default
instructions: "Review the last change; note what must still be fixed."
contextFiles: []
```

Typical `next:` from **review**:

```yaml
next:
  - if: step.status == "not_configured"
    then: log
  - if: step.has_changes == true
    then: fix
  - if: step.exit_code == 0
    then: commit
  - then: log
```

### fix

Address review findings, then return to review.

```yaml
provider: cursor
model: default
instructions: "Address the review findings in the working tree."
contextFiles: []
```

### log

Record outcome when review does not lead to commit.

```yaml
provider: cursor
model: default
instructions: "Record what happened in this run when we are not committing."
contextFiles: []
```

### commit

Prepare or create a commit when the tree is ready.

```yaml
provider: cursor
model: default
instructions: "Prepare or create the commit requested by the workflow."
contextFiles: []
```

### publish

Follow release or publish steps after commit.

```yaml
provider: cursor
model: default
instructions: "Follow your release or publish steps for this project."
contextFiles: []
```

### summarize

Summarize the latest run from logs (include run dir in the prompt).

```yaml
provider: cursor
model: default
instructions: >-
  Read `.aio/runs/latest` to find the current run id, then read
  `.aio/runs/<that id>/conversation.log`. Write a 2–3 sentence summary of what
  happened in that run (states visited, outcomes, any errors). Keep it factual.
contextFiles: []
prompt:
  include:
    - instructions
    - tracking_file
    - context_files
    - run_dir
```

---

## Full legacy default workflow

If you want the **old** linear pipeline back, copy this into
`.aio/workflows/default.yaml` and create the matching role files above.

```yaml
name: default
initial: analyse
states:
  analyse:
    role: analyse
    next: plan
  plan:
    role: plan
    next: build
  build:
    role: build
    next: review
  review:
    role: review
    next:
      - if: step.status == "not_configured"
        then: log
      - if: step.has_changes == true
        then: fix
      - if: step.exit_code == 0
        then: commit
      - then: log
  fix:
    role: fix
    next: review
  log:
    role: log
    next: done
  commit:
    role: commit
    next: publish
  publish:
    role: publish
    next: summarize
  summarize:
    role: summarize
    next: done
  done:
    type: final
```

---

## Ideas for richer stop logic (future runtime)

Today, each `if:` line in `next:` is one branch; combine several branches that
target `done` to approximate “stop if **any** of these hold.” A future **post-done
stop** feature ([`03.03.07`](../specs/02-requirements/03.03.07-post-done-stop-evaluator.md))
might express something like:

```yaml
# Illustrative only — not implemented
stop:
  any_of:
    - tasks_complete
    - score >= target_score
    - cost >= budget
    - no_improvement_iterations >= k
```

Until that exists, encode what you can with `step.*` conditions and keep
`maxSteps` conservative.
