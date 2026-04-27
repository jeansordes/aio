const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PACKAGE_ROOT = path.join(__dirname, "..");

/**
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {{ commit: string | null, dirty: boolean, committedAt: string } | null}
 */
function getDevBuildInfo(options = {}) {
  const env = options.env ?? process.env;
  if (env.AIO_DEV !== "1") {
    return null;
  }

  const cwd = options.cwd ?? PACKAGE_ROOT;
  /** @type {string | null} */
  let commit = null;
  /** @type {string} */
  let committedAt = "";
  let dirty = false;

  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    /* ignore */
  }

  try {
    committedAt = execFileSync("git", ["log", "-1", "--format=%cI"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    /* ignore */
  }

  if (!committedAt) {
    try {
      const stat = fs.statSync(path.join(__dirname, "cli.js"));
      committedAt = stat.mtime.toISOString();
    } catch {
      committedAt = "";
    }
  }

  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    dirty = porcelain.length > 0;
  } catch {
    dirty = false;
  }

  return { commit, dirty, committedAt };
}

module.exports = {
  getDevBuildInfo,
};
