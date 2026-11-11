const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { openSession } = require("../lib/session");
const { standaloneGoal } = require("../lib/graph");
const { runUntilPause, validateReport } = require("../lib/runtime");

function fixture(t, workflow = standaloneGoal("Build", ["Works"])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aio-runtime-"));
  const store = openSession(root);
  const bus = new EventEmitter();
  const detach = store.attach(bus);
  t.after(() => { detach(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "agent.cjs"), String.raw`
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const prompt = process.argv.at(-1);
    const target = JSON.parse(prompt.match(/report to (".*") \(relative/)[1]);
    const sessionPath = JSON.parse(prompt.match(/reading at (".*")\./)[1]);
    const state = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    fs.appendFileSync("prompts.jsonl", JSON.stringify({ prompt, args: process.argv }) + "\n");
    let report = { decision: "done", summary: "Implemented", evidence: ["Test passed"] };
    if (process.env.MODE === "continue") report = { decision: "continue", summary: "Made progress" };
    if (process.env.MODE === "block" && !state.guidance.length)
      report = { decision: "blocked", summary: "Checked", request: "Provide the fixture" };
    if (state.workflow.nodes[state.current].type === "route")
      report = { decision: "route", to: state.history.filter(h => h.node === "goal").length < 2 ? "goal" : "end", summary: "Review decision" };
    if (process.env.MODE === "cycle" && state.current === "route") report.to = "goal";
    if (process.env.MODE === "bad-route") report = { decision: "route", to: "missing", summary: "Bad destination" };
    if (process.env.MODE === "bad-report") report.evidence = [];
    fs.writeFileSync(target, JSON.stringify(report));
    if (process.env.MODE === "exit-failure") process.exit(1);
    if (process.env.MODE === "hang") {
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      console.log("ready-to-interrupt");
      setInterval(() => {}, 1000);
    }
  `);
  const loaded = { file: "test config", harnesses: {
    fixture: { command: process.execPath, args: ["agent.cjs", "{{model_args}}", "{{prompt}}"], modelArgs: ["--model", "{{model}}"] },
  } };
  const state = store.start(workflow, { harness: "fixture", model: "default-test-model" });
  async function run(mode, extra = {}) {
    const signal = new AbortController().signal;
    return runUntilPause({ root, store, state, loaded, bus, env: { ...process.env, MODE: mode }, signal, ...extra });
  }
  return { root, state, store, run, bus };
}

function cyclic() {
  const workflow = standaloneGoal("Build", ["Works"]);
  workflow.nodes.goal.next = "route";
  workflow.nodes.route = { type: "route", instructions: "Choose next", routes: [
    { to: "goal", description: "Needs changes" }, { to: "end", description: "All good" },
  ] };
  return workflow;
}

test("cycles create fresh visits; completed transitions resume from the snapshot", async (t) => {
  const workflow = cyclic();
  workflow.nodes.route.model = "review-model";
  const f = fixture(t, workflow);
  await f.run("", { pauseRequested: () => true });
  assert.equal(f.state.current, "route");
  assert.equal(f.state.history.length, 1);
  workflow.nodes.goal.objective = "External edits must not affect the snapshot";
  assert.equal(f.store.load().workflow.nodes.goal.objective, "Build");
  await f.run("");
  assert.equal(f.state.status, "done");
  assert.deepEqual(f.state.history.map(h => h.node), ["goal", "route", "goal", "route"]);
  assert.deepEqual(f.state.history.map(h => h.visit), [1, 2, 3, 4]);
  const prompts = fs.readFileSync(path.join(f.root, "prompts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(prompts[1].args.includes("review-model"));
  assert.match(prompts[2].prompt, /Implemented/);
  assert.equal(f.store.load().current, "end");
});

test("blocked input and per-goal limits pause without claiming completion", async (t) => {
  const graph = standaloneGoal("Build", ["Works"]);
  graph.nodes.goal.maxTurns = 2;
  const f = fixture(t, graph);
  await f.run("continue");
  assert.equal(f.state.turns, 2);
  assert.match(f.state.reason, /Goal turn limit/);
  await f.run("block");
  assert.match(f.state.reason, /Provide the fixture/);
  f.state.guidance.push({ node: "goal", text: "Use the local fixture" });
  await f.run("block");
  assert.equal(f.state.status, "done");
});

test("a global invocation cap bounds multi-node cycles", async (t) => {
  const graph = cyclic();
  graph.maxInvocations = 3;
  const f = fixture(t, graph);
  await f.run("cycle");
  assert.equal(f.state.history.length, 3);
  assert.equal(f.state.current, "route");
  assert.match(f.state.reason, /Invocation limit/);
});

test("invalid routes and completion evidence never commit a transition", async (t) => {
  const f = fixture(t);
  await f.run("bad-report");
  assert.equal(f.state.current, "goal");
  assert.equal(f.state.history.length, 0);
  assert.match(f.state.reason, /evidence/);
  await f.run("exit-failure");
  assert.equal(f.state.history.length, 0);
  assert.match(f.state.reason, /exited with 1/);
  assert.throws(() => validateReport({ decision: "route", to: "missing", summary: "why" }, cyclic().nodes.route), /allowed destination/);
});

test("interrupting a harness stops its children and rejects even an already-written report", { timeout: 8000 }, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  f.bus.on("providerStdout", ({ chunk }) => { if (chunk.includes("ready-to-interrupt")) controller.abort(); });
  await f.run("hang", { signal: controller.signal });
  assert.equal(f.state.status, "paused");
  assert.equal(f.state.interrupted, true);
  assert.equal(f.state.history.length, 0);
  assert.equal(f.store.load().inFlight, false);
  await f.run("");
  assert.equal(f.state.status, "done");
});

test("session locking and crash recovery preserve an unfinished invocation", (t) => {
  const f = fixture(t);
  assert.throws(() => openSession(f.root), /Session locked/);
  f.state.inFlight = true;
  f.store.save(f.state);
  const recovered = f.store.load();
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.status, "paused");
});
