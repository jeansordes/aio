---
name: commit-conventional
description: Create a scoped conventional commit for a completed roadmap requirement row, after verifying the implementation, spec, and roadmap note align.
---

# Commit Conventional

Use this skill when a concrete `specs/roadmap.csv` requirement row has just been
completed and the work needs its own conventional commit.

Read first:

1. `AGENT.md`
2. `specs/roadmap.csv`
3. The touched requirement spec file(s)

Contract:

- Commit boundary is one completed requirement unit.
- Start from requirement rows whose `status` just became `done`.
- If parent feature or domain rows also naturally become `done`, include those
  roadmap updates in the same commit.
- Do not bundle unrelated roadmap items into the same commit.
- Final check must confirm the roadmap note for the touched requirement row
  matches the committed behavior.

Commit type policy:

- `feat:` for new user-facing capability
- `fix:` for behavior correction
- `docs:`, `refactor:`, `test:`, `build:`, `chore:` only when no user-facing
  change is being shipped

Workflow:

1. Inspect `git diff --stat` and `git diff -- specs/roadmap.csv` to identify the
   completed requirement row.
2. Verify the implementation, spec file, and roadmap row all describe the same
   completed behavior.
3. Verify no unrelated `todo` or `in_progress` roadmap item is mixed into the
   same diff.
4. Choose the narrowest conventional commit type that truthfully describes the
   shipped behavior.
5. Write one decision-complete commit message for that requirement unit.
6. Before committing, re-read the touched roadmap row note and ensure it matches
   the actual code or workflow now present.
7. Commit exactly that requirement unit.

Suggested commands:

```bash
git diff --stat
git diff -- specs/roadmap.csv
git add <scoped files>
git commit -m "feat(scope): describe completed requirement"
```

Refuse to commit when:

- there is no concrete requirement row moving to `done`
- multiple unrelated requirement rows are being grouped together
- the roadmap note overstates or understates the actual behavior
- the workspace is not a real git checkout
