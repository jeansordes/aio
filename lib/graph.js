const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { mapping, nonempty, check, keys } = require("./harnesses");

function destinations(node) {
  return node.next ? [node.next] : node.routes ? node.routes.map((r) => r.to) : [];
}

function validateWorkflow(workflow) {
  check(workflow?.version === 2, "Incompatible workflow: version: 2 is required. Create a new workflow; old goal nodes are not supported.");
  keys(workflow, ["version", "name", "initial", "nodes", "maxInvocations"], "workflow");
  check(nonempty(workflow.name), "Workflow needs a name.");
  check(mapping(workflow.nodes) && Object.keys(workflow.nodes).length > 0, "Workflow needs nodes.");
  check(nonempty(workflow.initial) && Object.hasOwn(workflow.nodes, workflow.initial), "Invalid initial node.");
  if (workflow.maxInvocations !== undefined) check(Number.isSafeInteger(workflow.maxInvocations) &&
    workflow.maxInvocations > 0, "maxInvocations must be a positive integer.");
  for (const [id, node] of Object.entries(workflow.nodes)) {
    check(/^[a-zA-Z0-9_-]{1,64}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id), `Invalid node id: ${id}`);
    check(mapping(node), `Invalid node ${id}.`);
    const fields = {
      action: ["type", "name", "prompt", "modelProfile", "next"],
      route: ["type", "name", "prompt", "modelProfile", "criteria", "routes"],
      script: ["type", "name", "command", "args", "timeoutMs", "next", "routes"],
      end: ["type", "name"],
    };
    check(Object.hasOwn(fields, node.type), `Unknown node type at ${id}.`);
    keys(node, fields[node.type], `node ${id}`);
    if (node.name !== undefined) check(nonempty(node.name), `Invalid name at ${id}.`);
    if (["action", "route"].includes(node.type)) {
      check(nonempty(node.prompt), `Node ${id} needs a prompt.`);
      if (node.modelProfile === undefined) node.modelProfile = node.type === "action" ? "mid" : "low";
      check(nonempty(node.modelProfile), `Invalid modelProfile at ${id}.`);
    }
    if (node.type === "action") check(nonempty(node.next), `Action ${id} needs next.`);
    if (node.type === "script") {
      check(nonempty(node.command), `Script ${id} needs command.`);
      check(Array.isArray(node.args) && node.args.every(v => typeof v === "string"), `Script ${id} needs args.`);
      check((node.next !== undefined) !== (node.routes !== undefined), `Script ${id} needs exactly one of next or routes.`);
      if (node.next !== undefined) check(nonempty(node.next), `Invalid next at ${id}.`);
      if (node.timeoutMs !== undefined) check(Number.isSafeInteger(node.timeoutMs) && node.timeoutMs > 0 && node.timeoutMs <= 2147483647, `Invalid timeoutMs at ${id}.`);
    }
    if (node.criteria !== undefined) check(Array.isArray(node.criteria) && node.criteria.length > 0 && node.criteria.every(nonempty), `Invalid criteria at ${id}.`);
    if (node.type === "route" || node.routes !== undefined) {
      check(Array.isArray(node.routes) && node.routes.length > 0, `Route ${id} needs destinations.`);
      for (const route of node.routes) {
        keys(route, ["to", "description"], `route at ${id}`);
        check(nonempty(route.description), `Missing route description at ${id}.`);
      }
      check(new Set(node.routes.map(r => r.to)).size === node.routes.length, `Duplicate route at ${id}.`);
    }
    for (const to of destinations(node)) check(nonempty(to) && Object.hasOwn(workflow.nodes, to), `Unknown destination from ${id}: ${to}`);
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
  return validateWorkflow({ version: 2, name: "Goal", initial: "action", nodes: {
    action: { type: "action", name: "Work", prompt: objective + "\n\nExpected outcome:\n" + criteria.map(c => "- " + c).join("\n"), modelProfile: "mid", next: "validation" },
    validation: { type: "route", name: "Validation", prompt: "Independently inspect the project against every criterion. Return to the action with specific corrections when needed. Ask the user when essential information is missing.", modelProfile: "low", criteria,
      routes: [{ to: "action", description: "One or more criteria need corrections." }, { to: "end", description: "Every criterion is satisfied with evidence." }] },
    end: { type: "end", name: "Complete" },
  } });
}

module.exports = { destinations, validateWorkflow, readWorkflow, listWorkflows, standaloneGoal };
