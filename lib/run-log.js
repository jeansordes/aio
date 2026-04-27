const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function shortRunId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * @param {string} projectRoot
 * @param {{ workflowLabel: string, bus: import('node:events').EventEmitter }} options
 * @returns {{ runId: string, runDir: string, close: () => void }}
 */
function startRunLog(projectRoot, options) {
  const { workflowLabel, bus } = options;
  const runId = `${Date.now()}-${shortRunId()}`;
  const runsRoot = path.join(projectRoot, ".aio", "runs");
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const latestPath = path.join(runsRoot, "latest");
  fs.writeFileSync(latestPath, `${runId}\n`, "utf8");

  const metaPath = path.join(runDir, "meta.json");
  const startedAt = new Date().toISOString();
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify({ runId, workflow: workflowLabel, startedAt, projectRoot: path.resolve(projectRoot) }, null, 2)}\n`,
    "utf8",
  );

  const eventsPath = path.join(runDir, "events.jsonl");
  const convPath = path.join(runDir, "conversation.log");
  const eventsStream = fs.createWriteStream(eventsPath, { flags: "a" });
  const convStream = fs.createWriteStream(convPath, { flags: "a" });

  function writeEvent(payload) {
    eventsStream.write(`${JSON.stringify({ ts: Date.now(), ...payload })}\n`);
  }

  function convLine(text) {
    convStream.write(text);
  }

  const bindings = [
    [
      "runStart",
      (p) => {
        writeEvent({ type: "runStart", ...p });
        convLine(`\n--- aio run start workflow=${p.workflow} runId=${p.runId} ---\n`);
      },
    ],
    [
      "stateEnter",
      (p) => {
        writeEvent({ type: "stateEnter", ...p });
        convLine(`\n=== state: ${p.stateName} | role: ${p.roleName} | provider: ${p.providerName} ===\n`);
      },
    ],
    [
      "providerStart",
      (p) => {
        writeEvent({ type: "providerStart", ...p });
        convLine(`\n--- provider ${p.phase} start (${p.providerCommand}) ---\n`);
      },
    ],
    [
      "providerStdout",
      (p) => {
        writeEvent({ type: "providerStdout", ...p, chunk: undefined, chunkLen: p.chunk?.length ?? 0 });
        if (p.chunk) convStream.write(p.chunk);
      },
    ],
    [
      "providerStderr",
      (p) => {
        writeEvent({ type: "providerStderr", ...p, chunk: undefined, chunkLen: p.chunk?.length ?? 0 });
        if (p.chunk) {
          convStream.write(p.chunk);
        }
      },
    ],
    [
      "providerExit",
      (p) => {
        writeEvent({ type: "providerExit", ...p });
        convLine(
          `\n--- provider ${p.phase} exit status=${p.status} exit_code=${p.exit_code ?? "null"} durationMs=${p.durationMs} ---\n`,
        );
      },
    ],
    [
      "summary",
      (p) => {
        writeEvent({ type: "summary", ...p });
        convLine(`\n=== step summary (${p.stateName}) ===\n${p.text ?? ""}\n`);
      },
    ],
    [
      "stepMilestone",
      (p) => {
        writeEvent({ type: "stepMilestone", ...p });
      },
    ],
    [
      "transition",
      (p) => {
        writeEvent({ type: "transition", ...p });
        convLine(`\n--- transition ${p.from} -> ${p.to} ---\n`);
      },
    ],
    [
      "runEnd",
      (p) => {
        writeEvent({ type: "runEnd", ...p });
        convLine(`\n--- aio run end finalState=${p.finalState} ---\n`);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          meta.endedAt = new Date().toISOString();
          meta.finalState = p.finalState;
          fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        } catch {
          /* ignore */
        }
      },
    ],
    [
      "runError",
      (p) => {
        writeEvent({ type: "runError", ...p });
        convLine(`\n--- aio run error: ${p.message} ---\n`);
      },
    ],
  ];

  for (const [ev, fn] of bindings) {
    bus.on(ev, fn);
  }

  bus.emit("runStart", { runId, workflow: workflowLabel });

  function close() {
    for (const [ev, fn] of bindings) {
      bus.off(ev, fn);
    }
    eventsStream.end();
    convStream.end();
  }

  return { runId, runDir, close };
}

module.exports = {
  startRunLog,
  shortRunId,
};
