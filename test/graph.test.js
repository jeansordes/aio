const test = require("node:test");
const assert = require("node:assert/strict");
const { validateWorkflow, standaloneGoal } = require("../lib/graph");

test("a goal owns its objective and uses the same graph format as a cyclic workflow", () => {
  const graph = standaloneGoal("Implement", ["Tests pass"]);
  graph.nodes.goal.next = "review";
  graph.nodes.review = { type: "route", instructions: "Read the evidence", routes: [
    { to: "goal", description: "Needs changes" }, { to: "end", description: "All good" },
  ] };
  assert.equal(validateWorkflow(graph), graph);
  graph.objective = "A workflow cannot own an objective";
  assert.throws(() => validateWorkflow(graph), /Unknown workflow field/);
});

test("invalid graphs fail before any agent runs", () => {
  const graph = standaloneGoal("Implement", ["Tests pass"]);
  graph.nodes.goal.next = "missing";
  assert.throws(() => validateWorkflow(graph), /Unknown destination/);
  graph.nodes.goal.next = "goal";
  assert.throws(() => validateWorkflow(graph), /no path to an end/);
  graph.nodes.goal.next = "end";
  graph.nodes.goal.criteria = [];
  assert.throws(() => validateWorkflow(graph), /success criteria/);
  graph.nodes.goal.criteria = ["Tests pass"];
  graph.nodes.goal.maxTurns = 0;
  assert.throws(() => validateWorkflow(graph), /maxTurns/);
});
