const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { mapping, nonempty, check, keys } = require("./harnesses");

function destinations(node) {
  return node.type === "goal" ? [node.next] : node.type === "route" ? node.routes.map((r) => r.to) : [];
}

function validateWorkflow(workflow) {
  keys(workflow, ["name", "initial", "nodes", "maxInvocations"], "workflow");
  check(nonempty(workflow.name), "Workflow needs a name.");
  check(mapping(workflow.nodes) && Object.keys(workflow.nodes).length > 0, "Workflow needs nodes.");
  check(nonempty(workflow.initial) && Object.hasOwn(workflow.nodes, workflow.initial), "Invalid initial node.");
  if (workflow.maxInvocations !== undefined) check(Number.isSafeInteger(workflow.maxInvocations) &&
    workflow.maxInvocations > 0, "maxInvocations must be a positive integer.");

  for (const [id, node] of Object.entries(workflow.nodes)) {
    check(/^[a-zA-Z0-9_-]{1,64}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id), `Invalid node id: ${id}`);
    check(mapping(node), `Invalid node ${id}.`);
    const fields = {
      goal: ["type", "objective", "criteria", "instructions", "harness", "model", "maxTurns", "next"],
      route: ["type", "instructions", "harness", "model", "routes"],
      end: ["type"],
    };
    check(Object.hasOwn(fields, node.type), `Unknown node type at ${id}.`);
    keys(node, fields[node.type], `node ${id}`);
    for (const key of ["harness", "model", "instructions"]) {
      if (node[key] !== undefined) check(nonempty(node[key]), `Invalid ${key} at ${id}.`);
    }
    if (node.type === "goal") {
      check(nonempty(node.objective), `Goal ${id} needs an objective.`);
      check(Array.isArray(node.criteria) && node.criteria.length > 0 && node.criteria.every(nonempty),
        `Goal ${id} needs success criteria.`);
      if (node.maxTurns !== undefined) check(Number.isSafeInteger(node.maxTurns) && node.maxTurns > 0,
        `Invalid maxTurns at ${id}.`);
    } else if (node.type === "route") {
      check(nonempty(node.instructions), `Route ${id} needs instructions.`);
      check(Array.isArray(node.routes) && node.routes.length > 0, `Route ${id} needs destinations.`);
      for (const route of node.routes) {
        keys(route, ["to", "description"], `route at ${id}`);
        check(nonempty(route.description), `Missing route description at ${id}.`);
      }
      check(new Set(node.routes.map((r) => r.to)).size === node.routes.length, `Duplicate route at ${id}.`);
    }
    for (const to of destinations(node)) check(nonempty(to) && Object.hasOwn(workflow.nodes, to),
      `Unknown destination from ${id}: ${to}`);
  }
  const reachable = new Set();
  const queue = [workflow.initial];
  while (queue.length) {
    const id = queue.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...destinations(workflow.nodes[id]));
  }
  const canEnd = new Set(Object.keys(workflow.nodes).filter((id) => workflow.nodes[id].type === "end"));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      if (!canEnd.has(id) && destinations(workflow.nodes[id]).some((to) => canEnd.has(to))) {
        canEnd.add(id);
        changed = true;
      }
    }
  }
  for (const id of reachable) check(canEnd.has(id), `Node ${id} has no path to an end.`);
  return workflow;
}

function readWorkflow(file) {
  return validateWorkflow(YAML.parse(fs.readFileSync(file, "utf8")));
}

function listWorkflows(root) {
  const dir = path.join(root, ".aio", "workflows");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ name: entry.name, file: path.join(dir, entry.name) }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function standaloneGoal(objective, criteria) {
  return validateWorkflow({ name: "Goal", initial: "goal", nodes: {
    goal: { type: "goal", objective, criteria, next: "end" },
    end: { type: "end" },
  } });
}

module.exports = { destinations, validateWorkflow, readWorkflow, listWorkflows, standaloneGoal };
