# AGENTS

This file is **`AGENTS.md`** (plural). That name is widely used for root-level instructions to AI coding agents (including Cursor). It used to live as `AGENT.md` in this repo.

## Specs and roadmap

Read `specs/`.  
Read `specs/roadmap.csv`.

### Order

1. `specs/roadmap.csv`
2. `00-domains/`
3. `01-features/`
4. `02-requirements/`

Low number = more global.  
High number = more concrete.

Do not skip levels. Read from low to high.

If specs conflict, **lower folder wins**.

`roadmap.csv` is the registry. Keep it aligned with specs and code.

### When to update `roadmap.csv`

- When a spec changes
- When implementation changes

### Columns

**`status`:** `todo` | `in_progress` | `done`

**`priority`:** `a` (critical) > `b` (important) > `c` (nice to have)

**`blocked_by`:** empty means unblocked; otherwise list requirement ids that must be satisfied first.

### Picking next work

1. Not blocked
2. Highest priority (`a` > `b` > `c`)
3. Most concrete item (finest-grained id)

### Johnny Decimal ids

- **Domain:** `xx` (e.g. `00`)
- **Feature:** `domain-id.xx` (e.g. `00.00`)
- **Requirement:** `domain-id.feature-id.xx` (e.g. `00.00.00`)

Name paths after the id: short slug, lowercase, dash-separated words.

Examples:

- `00-update`
- `00.00-update-on-start`
- `00.00.00-update-global-install-only`

## Commits and releases

- **Single completed requirement:** follow **`.agents/skills/commit-conventional/SKILL.md`** (one conventional commit per requirement unit; read this file and the touched spec rows first).
- **Ship a version:** follow **`.agents/skills/release-semver/SKILL.md`** after the relevant `feat` / `fix` commits are on the branch you intend to release.

## Push to GitHub

When work should be on the remote (normal feature work, docs, or after cutting a release), **push the branch and any new version tags**. Releases are **tag-driven**: the workflow in `.github/workflows/release.yml` publishes to npm from pushed `vX.Y.Z` tags.

```bash
git push origin main
```

After creating a release tag locally:

```bash
git push origin vX.Y.Z
```

To push all local tags:

```bash
git push origin --tags
```

If the operator asked to publish or “push everything,” run the branch push and the tag push (or `--tags` when several tags are new).
