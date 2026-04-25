"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const conventionalChangelog = require("conventional-changelog").default;

async function main() {
  if (!isGitCheckout()) {
    throw new Error("This command must run inside a real git checkout.");
  }

  const changelogPath = path.resolve(__dirname, "..", "CHANGELOG.md");
  const tempPath = `${changelogPath}.tmp`;

  const changelogStream = conventionalChangelog({
    preset: "conventionalcommits",
    releaseCount: 0,
  });

  await pipeline(changelogStream, fs.createWriteStream(tempPath, "utf8"));
  fs.renameSync(tempPath, changelogPath);
}

function isGitCheckout() {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === "true"
    );
  } catch (error) {
    return false;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
