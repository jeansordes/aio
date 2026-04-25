"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  bumpVersion,
  getRecommendedBump,
  parseConventionalCommit,
} = require("../lib/conventional-release.js");

const packageJsonPath = path.resolve(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;

if (!isGitCheckout()) {
  const message = "This command must run inside a real git checkout.";

  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ currentVersion, latestTag: null, bump: null, nextVersion: null, commits: [], error: message }, null, 2)}\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const latestTag = getLatestTag();
const rawCommits = getCommitMessagesSince(latestTag);
const commits = rawCommits.map(parseConventionalCommit);
const bump = getRecommendedBump(commits);
const nextVersion = bump ? bumpVersion(currentVersion, bump) : null;

const report = {
  currentVersion,
  latestTag,
  bump,
  nextVersion,
  commits: commits.map((commit) => ({
    header: commit.header,
    type: commit.type,
    scope: commit.scope,
    isBreaking: commit.isBreaking,
    releaseSignal: commit.releaseSignal,
  })),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

printReport(report);

function isGitCheckout() {
  try {
    return runGit(["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch (error) {
    return false;
  }
}

function getLatestTag() {
  try {
    return runGit(["describe", "--tags", "--abbrev=0"]);
  } catch (error) {
    if (isMissingTagError(error)) {
      return null;
    }

    throw error;
  }
}

function getCommitMessagesSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const output = runGit(["log", "--format=%B%x1e", "--reverse", range]);

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isMissingTagError(error) {
  const stderr = String(error.stderr || "");
  return error.status === 128 && /No names found|No tags can describe/i.test(stderr);
}

function printReport(result) {
  process.stdout.write(`Current version: ${result.currentVersion}\n`);
  process.stdout.write(`Latest tag: ${result.latestTag || "(none)"}\n`);

  if (!result.commits.length) {
    process.stdout.write("Conventional commits since latest tag: none\n");
    process.stdout.write("Recommended bump: none\n");
    return;
  }

  process.stdout.write("Commits since latest tag:\n");

  for (const commit of result.commits) {
    const signal = commit.releaseSignal || "none";
    process.stdout.write(`- ${commit.header || "(no header)"} [${signal}]\n`);
  }

  process.stdout.write(`Recommended bump: ${result.bump || "none"}\n`);

  if (result.nextVersion) {
    process.stdout.write(`Next version: ${result.nextVersion}\n`);
  }
}
