const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { nonempty, check, resolveHarness } = require("./harnesses");
const { runHarness } = require("./harness-process");

function buildNodePrompt(state, reportPath, sessionPath) {
  const node = state.workflow.nodes[state.current];
  const common = [
    "You are executing one node of an aio workflow. Preserve existing user changes.",
    "Only work within the project. Do not edit aio session files except the report requested below.",
    "Write your final JSON report to " + JSON.stringify(reportPath) + " (relative to the project root).",
    "Full prior results are available for reading at " + JSON.stringify(sessionPath) + ".",
    `Current node: ${state.current}; visit: ${state.visit}; completed turns: ${state.turns}.`,
    "Recent results by node: " + JSON.stringify(Object.fromEntries(Object.entries(state.results).map(
      ([id, result]) => [id, { decision: result.decision, summary: result.summary.slice(0, 1500), to: result.to }]))),
    "User guidance: " + JSON.stringify(state.guidance),
    "Checkpoint for this visit: " + (state.summary || "(none)"),
    ...(state.interrupted ? ["A prior invocation was interrupted. Inspect the actual project state before proceeding."] : []),
    node.instructions ?? "",
    'If progress requires the user, report {"decision":"blocked","summary":"progress and attempts","request":"what you need"}.',
  ];
  if (node.type === "goal") {
    common.push(
      "Objective: " + node.objective,
      "Success criteria:\n" + node.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
      'If incomplete, report {"decision":"continue","summary":"progress, checks and next action"}.',
      'If all criteria are satisfied, report {"decision":"done","summary":"result","evidence":["proof for criterion 1","..."]}.',
      "Provide exactly one nonempty evidence entry per criterion in order. A review is complete when its report is written, even if it found problems.",
    );
  } else {
    common.push(
      "Your only task is choosing the next node. You may inspect project files, but do not change them or perform the Goals' work.",
      "Allowed routes: " + JSON.stringify(node.routes),
      'Report {"decision":"route","to":"one allowed destination","summary":"justification of this choice"}.',
    );
  }
  return common.join("\n\n");
}

function validateReport(report, node) {
  check(report && nonempty(report.summary), "Missing report summary.");
  if (report.decision === "blocked") {
    check(nonempty(report.request), "A blocked report must explain what the user needs to provide.");
  } else if (node.type === "goal") {
    check(["continue", "done"].includes(report.decision), "Invalid Goal decision.");
    if (report.decision === "done") check(Array.isArray(report.evidence) &&
      report.evidence.length === node.criteria.length && report.evidence.every(nonempty),
    "Completion requires evidence for every criterion.");
  } else {
    check(report.decision === "route" && node.routes.some((r) => r.to === report.to),
      "Routing must select an allowed destination.");
  }
  // Store only the supported fields; ignore arbitrary additions from the agent.
  return Object.fromEntries(["decision", "summary", "request", "evidence", "to"]
    .filter((key) => report[key] !== undefined).map((key) => [key, report[key]]));
}

function readReport(file, node) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= 65536, "Invalid or oversized report file.");
    return validateReport(JSON.parse(fs.readFileSync(fd, "utf8")), node);
  } finally { fs.closeSync(fd); }
}

async function runUntilPause({ root, state, store, loaded, env = process.env,
  signal, pauseRequested = () => false, bus = new EventEmitter() }) {
  let invocations = 0;
  let goalTurns = 0;
  function pause(reason, interrupted = false) {
    Object.assign(state, { status: "paused", reason, interrupted, inFlight: false });
    store.save(state);
    bus.emit("paused", { node: state.current, reason });
    return state;
  }
  while (true) {
    if (signal.aborted) return pause("Stopped. Reopen aio to resume.", state.interrupted);
    const node = state.workflow.nodes[state.current];
    if (node.type === "end") {
      Object.assign(state, { status: "done", reason: null, inFlight: false });
      store.save(state);
      bus.emit("completed", { node: state.current });
      return state;
    }
    let harness;
    try { harness = resolveHarness(node, state.defaults, loaded, env); }
    catch (error) { return pause(error.message, state.interrupted); }
    const reportFile = path.join(store.dir, `report-${randomUUID()}.json`);
    const prompt = buildNodePrompt(state, path.relative(root, reportFile), path.relative(root, store.file));
    Object.assign(state, { status: "running", inFlight: true, reason: null });
    store.save(state);
    bus.emit("nodeEnter", { node: state.current, visit: state.visit, turn: state.turns + 1, harness: harness.id });
    let report;
    let failure;
    try {
      const result = await runHarness({ harness, root, env, prompt, signal, bus, nodeId: state.current });
      invocations++;
      if (!signal.aborted) {
        if (result.error) throw result.error;
        check((harness.successExitCodes ?? [0]).includes(result.code),
          `Harness exited with ${result.termSignal ?? result.code}.`);
        report = readReport(reportFile, node);
      }
    } catch (error) { failure = error.code === "ENOENT" ? "The harness did not write its report." : error.message; }
    finally {
      // Invalid directories are left for inspection; files and symlinks are unlinked.
      try { if (!fs.lstatSync(reportFile).isDirectory()) fs.unlinkSync(reportFile); }
      catch (error) { if (error.code !== "ENOENT") failure ??= error.message; }
    }
    if (signal.aborted) return pause("The last invocation was interrupted and may have changed project files.", true);
    if (failure) return pause(`Invocation failed: ${failure} Project files may already contain changes.`, true);

    const from = state.current;
    state.turns++;
    state.history.push({ node: from, visit: state.visit, turn: state.turns, report });
    state.results[from] = report;
    Object.assign(state, { inFlight: false, interrupted: false, summary: report.summary });
    if (node.type === "goal") goalTurns++;
    let to;
    if (report.decision === "done") to = node.next;
    if (report.decision === "route") to = report.to;
    if (to) {
      Object.assign(state, { current: to, visit: state.visit + 1, turns: 0, summary: "" });
      goalTurns = 0;
    }
    // Results and next position share one atomic commit, even across a routing edge.
    store.save(state);
    bus.emit("checkpoint", { node: from, visit: state.visit - (to ? 1 : 0), report });
    if (to) bus.emit("transition", { from, to });
    if (report.decision === "blocked") return pause(`Your input is needed: ${report.request}`);
    if (state.workflow.nodes[state.current].type === "end") continue;
    if (pauseRequested()) return pause("Paused at your request.");
    if (invocations >= (state.workflow.maxInvocations ?? 100)) return pause("Invocation limit reached. Review progress before continuing.");
    if (goalTurns >= (node.maxTurns ?? 10)) return pause("Goal turn limit reached. Review progress before continuing.");
  }
}

module.exports = { runUntilPause, buildNodePrompt, validateReport };
