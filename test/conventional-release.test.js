const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bumpVersion,
  getRecommendedBump,
  parseConventionalCommit,
} = require("../lib/conventional-release.js");

test("parseConventionalCommit detects fix commits as patch releases", () => {
  const commit = parseConventionalCommit("fix(cli): handle missing tag output");

  assert.equal(commit.isConventional, true);
  assert.equal(commit.type, "fix");
  assert.equal(commit.scope, "cli");
  assert.equal(commit.releaseSignal, "patch");
  assert.equal(commit.isBreaking, false);
});

test("parseConventionalCommit detects feat commits as minor releases", () => {
  const commit = parseConventionalCommit("feat(release): add semver planning");

  assert.equal(commit.releaseSignal, "minor");
  assert.equal(commit.isBreaking, false);
});

test("parseConventionalCommit detects bang syntax and breaking footer as major releases", () => {
  const bangCommit = parseConventionalCommit("feat(api)!: rename command");
  const footerCommit = parseConventionalCommit([
    "fix(parser): stop truncating body",
    "",
    "BREAKING CHANGE: parser output keys changed",
  ].join("\n"));

  assert.equal(bangCommit.releaseSignal, "major");
  assert.equal(bangCommit.isBreaking, true);
  assert.equal(footerCommit.releaseSignal, "major");
  assert.equal(footerCommit.isBreaking, true);
});

test("getRecommendedBump prefers major over minor over patch", () => {
  assert.equal(
    getRecommendedBump([
      "fix(cli): quiet warning",
      "feat(release): add changelog sync",
    ]),
    "minor",
  );

  assert.equal(
    getRecommendedBump([
      "fix(cli): quiet warning",
      "chore!: drop old config key",
    ]),
    "major",
  );
});

test("getRecommendedBump skips non-qualifying commits", () => {
  assert.equal(
    getRecommendedBump([
      "docs(readme): explain release flow",
      "chore(ci): tidy workflow names",
    ]),
    null,
  );
});

test("bumpVersion applies patch, minor, and major semantics", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", null), "1.2.3");
});
