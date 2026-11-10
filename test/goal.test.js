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
const report = JSON.parse(prompt.match(/write a JSON report at (".*") \(relative/)[1]);
function write(value) { fs.writeFileSync(report, JSON.stringify(value)); }
if (name === "no-evidence") {
  write({ decision: "done", summary: "Claims success with no evidence.", evidence: [] });
} else if (name === "codex") {
  if (!prompt.includes('User guidance: ["Use the local fixture"]')) {
    write({ decision: "blocked", summary: "Checked the inputs.", request: "Which fixture?" });
  } else {
    write({ decision: "done", summary: "Checked the local fixture.", evidence: ["fixture check passed"] });
  }
} else if (!prompt.includes("Last saved checkpoint: First checkpoint.")) {
  console.log("First turn running");
  setTimeout(() => write({ decision: "continue", summary: "First checkpoint." }), 500);
} else if (!prompt.includes("User guidance: [\"Finish now\"]")) {
  // Inherit the pipes so aio cannot finish quitting unless it stops this tool too.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  write({ decision: "done", summary: "Uncommitted report", evidence: ["premature evidence"] });
  console.log("Harness and tool are running");
  setInterval(() => {}, 1000);
} else {
  if (!prompt.includes("prior attempt was interrupted")) process.exit(2);
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
  return JSON.parse(fs.readFileSync(path.join(root, ".aio/sessions/goal/session.json"), "utf8"));
}

function open(t, root, { pathEnv = "", maxTurns } = {}) {
  const child = spawn(process.execPath, ["-e",
    `require(${JSON.stringify(cli)}).routeCommand([], { stdinIsTTY: true, stdoutIsTTY: true, goalMaxTurns: ${maxTurns} }).catch(e => { console.error(e); process.exitCode = 1; })`,
  ], { cwd: root, env: { ...process.env, PATH: pathEnv } });
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
  await enterGoal(app);
  await app.see("Your input is needed: Which fixture?");
  assert.equal(readState(root).turns, 1);
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
  fs.mkdirSync(path.join(root, ".aio"));
  fs.writeFileSync(path.join(root, ".aio/providers.yaml"), YAML.stringify({ providers: {
    fixture: { command: process.execPath, args: ["harness.cjs", "custom", "{{prompt}}"] },
  } }));
  const app = open(t, root);
  await enterGoal(app);
  await app.see("First turn running");
  app.type("p");
  await app.see("Paused at your request.");
  assert.equal(readState(root).turns, 1);
  await app.see("Press Enter to resume");
  app.type("");
  await app.see("Harness and tool are running");
  app.interrupt();
  await app.see("The last turn was interrupted");
  await app.exit();
  const state = readState(root);
  assert.equal(state.status, "paused");
  assert.equal(state.turns, 1);
  assert.equal(state.summary, "First checkpoint.");
  assert.equal(state.interrupted, true);

  const resumed = open(t, root);
  await resumed.see("Saved goal: Verify the fixture");
  await resumed.see("last turn was interrupted");
  await resumed.see("[R]esume");
  resumed.type("r");
  await resumed.see("Add guidance");
  resumed.type("Finish now");
  await resumed.see("saved checkpoint reused");
  await resumed.exit();
  assert.equal(readState(root).status, "done");
  assert.equal(readState(root).turns, 2);
});

test("the turn cap pauses the loop and persists the last completed turn", { timeout: 10000 }, async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, ".aio"));
  fs.writeFileSync(path.join(root, ".aio/providers.yaml"), YAML.stringify({ providers: {
    fixture: { command: process.execPath, args: ["harness.cjs", "custom", "{{prompt}}"] },
  } }));
  const app = open(t, root, { maxTurns: 1 });
  await enterGoal(app);
  await app.see("Paused after 1 turn.");
  await app.see("Press Enter to resume");
  app.type("q");
  await app.exit();
  assert.equal(readState(root).status, "paused");
  assert.equal(readState(root).turns, 1);
});

test("a successful harness exit cannot complete a goal without evidence", { timeout: 10000 }, async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, ".aio"));
  fs.writeFileSync(path.join(root, ".aio/providers.yaml"), YAML.stringify({ providers: {
    fixture: { command: process.execPath, args: ["harness.cjs", "no-evidence", "{{prompt}}"] },
  } }));
  const app = open(t, root);
  await enterGoal(app);
  await app.see("The harness report has no valid decision, evidence, or request.");
  await app.see("Press Enter to resume");
  app.type("q");
  await app.exit();
  assert.equal(readState(root).status, "paused");
  assert.equal(readState(root).turns, 0);
});
