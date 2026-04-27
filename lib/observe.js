const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} projectRoot
 * @param {{ runId?: string, events?: boolean, stdout?: NodeJS.WriteStream }} options
 * @returns {Promise<void>}
 */
async function observeRun(projectRoot, options = {}) {
  const root = path.resolve(projectRoot ?? process.cwd());
  const runsRoot = path.join(root, ".aio", "runs");
  const runId = options.runId?.trim() || readLatestRunId(runsRoot);
  if (!runId) {
    throw new Error("aio: no runs found under .aio/runs. Run aio run first.");
  }
  const runDir = path.join(runsRoot, runId);
  if (!fs.existsSync(runDir)) {
    throw new Error(`aio: run ${runId} not found.`);
  }

  const fileName = options.events ? "events.jsonl" : "conversation.log";
  const filePath = path.join(runDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`aio: missing ${fileName} for run ${runId}.`);
  }

  const stdout = options.stdout ?? process.stdout;
  let position = 0;

  function dumpNew() {
    const stat = fs.statSync(filePath);
    if (stat.size < position) {
      position = 0;
    }
    if (stat.size === position) {
      return;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const len = stat.size - position;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, position);
      position = stat.size;
      stdout.write(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }

  dumpNew();

  return new Promise((resolve, reject) => {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === "rename") {
        return;
      }
      try {
        dumpNew();
      } catch (err) {
        reject(err);
      }
    });
    watcher.on("error", reject);
    process.on("SIGINT", () => {
      watcher.close();
      resolve();
    });
  });
}

function readLatestRunId(runsRoot) {
  const latestPath = path.join(runsRoot, "latest");
  if (!fs.existsSync(latestPath)) {
    return null;
  }
  return fs.readFileSync(latestPath, "utf8").trim().split("\n")[0] || null;
}

module.exports = {
  observeRun,
  readLatestRunId,
};
