const test = require("node:test");
const assert = require("node:assert/strict");
const { renderGraph } = require("../lib/workflow-view");
const { standaloneGoal } = require("../lib/graph");

test("ASCII view identifies current nodes, branches and cycles and wraps to terminal width", () => {
  const workflow = standaloneGoal("An objective that is longer than a narrow terminal", ["Works"]);
  workflow.nodes.goal.next = "review";
  workflow.nodes.review = { type: "route", instructions: "Choose", routes: [
    { to: "goal", description: "Corrections required" }, { to: "end", description: "Success" },
  ] };
  const state = { workflow, current: "review", visit: 2, turns: 0, status: "running",
    results: { goal: { decision: "done" } } };
  const normal = renderGraph(state).join("\n");
  assert.match(normal, /\[>\] review/);
  assert.match(normal, /\+--> goal : Corrections required/);
  assert.match(normal, /\[x\] goal/);
  const narrow = renderGraph(state, 25);
  assert.ok(narrow.every((line) => [...line].length < 25));
  state.status = "paused";
  assert.match(renderGraph(state).join("\n"), /\[!\] review/);
});
