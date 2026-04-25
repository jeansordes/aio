# Release Semver

Use this skill when the repo is in a real git checkout and a release may need to
be prepared from conventional commits.

Read first:

1. `package.json`
2. `CHANGELOG.md`
3. `.github/workflows/release.yml`
4. `scripts/release-plan.js`

Version policy:

- `fix` => patch
- `feat` => minor
- breaking change footer or `!` => major
- no qualifying commits => no release

Workflow:

1. Find the latest tag.
2. Collect conventional commits since that tag.
3. Compute the semver bump from those commits only.
4. Update `package.json` version.
5. Regenerate `CHANGELOG.md`.
6. Create release commit `chore(release): vX.Y.Z`.
7. Create matching `vX.Y.Z` tag.
8. Tell the operator to push the release commit and tag so
   `.github/workflows/release.yml` publishes.

Suggested commands:

```bash
npm run release:plan
npm version --no-git-tag-version X.Y.Z
npm run changelog:write
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z
```

Checks:

- Do not add a separate subjective filter beyond conventional-commit semver
  signals since the latest tag.
- Stop when `npm run release:plan` reports `Recommended bump: none`.
- Ensure the created tag format stays `vX.Y.Z`.
- Do not push automatically unless the operator explicitly asks.
- If this workspace is missing `.git`, stop after reporting that release
  preparation must be run in a real git checkout.
