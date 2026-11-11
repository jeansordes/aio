const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const YAML = require("yaml");

const cli = require.resolve("../lib/cli");
const fixture = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [name, arg] = process.argv.slice(2);
const prompt = arg ?? fs.readFileSync(0, "utf8");
const report = JSON.parse(prompt.match(/report to (".*") \(relative/)[1]);
function write(value) { fs.writeFileSync(report, JSON.stringify(value)); }
if (name === "no-evidence") {
  write({ decision: "done", summary: "Claims success with no evidence.", evidence: [] });
} else if (name === "codex") {
  if (!prompt.includes("Use the local fixture")) {
    write({ decision: "blocked", summary: "Checked the inputs.", request: "Which fixture?" });
  } else {
    write({ decision: "done", summary: "Checked the local fixture.", evidence: ["fixture check passed"] });
  }
} else if (!prompt.includes("Checkpoint for this visit: First checkpoint.")) {
  console.log("First turn running");
  setTimeout(() => write({ decision: "continue", summary: "First checkpoint." }), 500);
} else if (!prompt.includes("Finish now")) {
  // Inherit the pipes so aio cannot finish quitting unless it stops this tool too.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  write({ decision: "done", summary: "Uncommitted report", evidence: ["premature evidence"] });
  console.log("Harness and tool are running");
  setInterval(() => {}, 1000);
} else {
  if (!prompt.includes("prior invocation was interrupted")) process.exit(2);
  write({ decision: "done", summary: "Resumed the goal.", evidence: ["saved checkpoint reused"] });
}
`;

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aio-goal-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.writeFileSync(path.join(root, "harness.cjs"), fixture);
  return root;
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".aio/sessions/current/session.json"), "utf8"));
}

function open(t, root, { pathEnv = "" } = {}) {
  const child = spawn(process.execPath, ["-e",
    `require(${JSON.stringify(cli)}).routeCommand([], { stdinIsTTY: true, stdoutIsTTY: true,  }).catch(e => { console.error(e); process.exitCode = 1; })`,
  ], { cwd: root, env: { ...process.env, PATH: pathEnv, XDG_CONFIG_HOME: path.join(root, "global") } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = "";
  let cursor = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  let closed = false;
  const exit = new Promise((resolve) => child.on("close", (code) => { closed = true; resolve(code); }));
  async function see(value) {
    const deadline = Date.now() + 4000;
    for (;;) {
      const match = output.indexOf(value, cursor);
      if (match !== -1) {
        cursor = match + value.length;
        return;
      }
      assert.ok(Date.now() < deadline && !closed, `Expected "${value}" in:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { see, type: (line) => child.stdin.write(line + "\r"), interrupt: () => child.stdin.write("\x03"),
    exit: async () => assert.equal(await exit, 0, output) };
}

async function enterGoal(app) {
  await app.see("Start a session");
  await app.see("Choose [1]");
  app.type("1");
  await app.see("What goal should aio work toward?");
  app.type("Verify the fixture");
  await app.see("Criterion 1:");
  app.type("The fixture check passes");
  await app.see("Criterion 2:");
  app.type("");
}

test("bare aio runs a built-in harness without init and resumes from a blocker with guidance", {
  skip: process.platform === "win32", timeout: 10000,
}, async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, "codex"),
    `#!${process.execPath}\nprocess.argv.splice(2, Infinity, "codex");\n${fixture}`, { mode: 0o700 });
  const app = open(t, root, { pathEnv: root });
  await app.see("Default harness");
  await app.see("Choose [1]");
  app.type("1");
  await enterGoal(app);
  await app.see("Your input is needed: Which fixture?");
  assert.equal(readState(root).history.length, 1);
  await app.see("Press Enter to resume");
  app.type("Use the local fixture");
  await app.see("The fixture check passes: fixture check passed");
  await app.exit();
  assert.equal(readState(root).status, "done");
  assert.equal(fs.existsSync(path.join(root, ".aio/config.yaml")), false);
});

test("custom harness pauses after a turn, quits with Ctrl+C, and resumes from the saved checkpoint", {
  skip: process.platform === "win32", timeout: 15000,
}, async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, "global/aio"), { recursive: true });
  fs.writeFileSync(path.join(root, "global/aio/config.yaml"), YAML.stringify({ defaultHarness: "fixture", harnesses: {
    fixture: { command: process.execPath, args: [path.join(root, "harness.cjs"), "custom", "{{prompt}}"] },
  } }));
  const app = open(t, root);
  await enterGoal(app);
  await app.see("First turn running");
  app.type("p");
  await app.see("Paused at your request.");
  assert.equal(readState(root).history.length, 1);
  await app.see("Press Enter to resume");
  app.type("");
  await app.see("Harness and tool are running");
  app.interrupt();
  await app.see("The last invocation was interrupted");
  await app.exit();
  const state = readState(root);
  assert.equal(state.status, "paused");
  assert.equal(state.history.length, 1);
  assert.equal(state.summary, "First checkpoint.");
  assert.equal(state.interrupted, true);

  const resumed = open(t, root);
  await resumed.see("Saved session: Goal");
  await resumed.see("last invocation was interrupted");
  await resumed.see("Choose [1]");
  resumed.type("1");
  await resumed.see("Add guidance");
  resumed.type("Finish now");
  await resumed.see("saved checkpoint reused");
  await resumed.exit();
  assert.equal(readState(root).status, "done");
  assert.equal(readState(root).history.length, 2);
});

test("a successful harness exit cannot complete a goal without evidence", { timeout: 10000 }, async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, "global/aio"), { recursive: true });
  fs.writeFileSync(path.join(root, "global/aio/config.yaml"), YAML.stringify({ defaultHarness: "fixture", harnesses: {
    fixture: { command: process.execPath, args: [path.join(root, "harness.cjs"), "no-evidence", "{{prompt}}"] },
  } }));
  const app = open(t, root);
  await enterGoal(app);
  await app.see("Completion requires evidence for every criterion.");
  await app.see("Press Enter to resume");
  app.type("q");
  await app.exit();
  assert.equal(readState(root).status, "paused");
  assert.equal(readState(root).history.length, 0);
});

test("the interactive menu loads a project workflow and preserves its snapshot", { timeout: 10000 }, async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, "global/aio"), { recursive: true });
  fs.writeFileSync(path.join(root, "global/aio/config.yaml"), YAML.stringify({
    defaultHarness: "fixture", harnesses: {
      fixture: { command: process.execPath, args: [path.join(root, "harness.cjs"), "custom", "{{prompt}}"] },
    },
  }));
  fs.mkdirSync(path.join(root, ".aio/workflows"), { recursive: true });
  const workflow = {
    name: "Chosen workflow", initial: "build", nodes: {
      build: { type: "goal", objective: "Build it", criteria: ["Works"], maxTurns: 1, next: "end" },
      end: { type: "end" },
    },
  };
  fs.writeFileSync(path.join(root, ".aio/workflows/build.yaml"), YAML.stringify(workflow));
  const app = open(t, root);
  await app.see("Workflow — build.yaml");
  await app.see("Choose [1]");
  app.type("2");
  await app.see("Goal turn limit reached.");
  await app.see("Press Enter to resume");
  app.type("q");
  await app.exit();
  assert.deepEqual(readState(root).workflow, workflow);
  assert.equal(readState(root).current, "build");
});
