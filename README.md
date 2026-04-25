# `@jeansordes/aio`

Minimal placeholder package for:

```bash
npx @jeansordes/aio
```

and:

```bash
bunx @jeansordes/aio
```

Current output:

```text
Hi! Welcome to Jean Sordes's AI Orchestrator, a tool for orchestrating AI agents in coding project. The project is currently under construction, stay tuned !
```

## Roadmap Commits

Implementation work follows `specs/roadmap.csv`.

Each concrete requirement row that becomes `done` gets exactly one conventional
commit. Parent feature or domain rows can be updated in that same commit only if
they naturally become `done` from the same work.

The repo-local skill for this flow lives at
`.agents/skills/commit-conventional/SKILL.md`.

## Changelog

`CHANGELOG.md` is generated from conventional commit history.

On pushes to the default branch, `.github/workflows/changelog.yml` regenerates
the file and commits it back only when the content changed. The workflow skips
its own `chore(changelog): ...` commits to avoid an infinite loop.

For a local refresh in a real git checkout:

```bash
npm install
npm run changelog:write
```

## Releases

Recommended flow:

1. Use conventional commits for roadmap-scoped work.
2. Run `npm run release:plan` to inspect commits since the latest tag.
3. If the recommended bump is `patch`, `minor`, or `major`, update
   `package.json` locally.
4. Regenerate `CHANGELOG.md`.
5. Commit with `chore(release): vX.Y.Z`.
6. Create a matching tag such as `v0.0.1`.
7. Push the release commit and tag.
8. GitHub Actions uses npm Trusted Publishing via GitHub OIDC to publish to npm.
9. The same workflow creates the matching GitHub Release.

Repo-local release instructions live at
`.agents/skills/release-semver/SKILL.md`.

The publishing workflow lives in `.github/workflows/release.yml`.
