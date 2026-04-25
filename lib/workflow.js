const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");

function runWorkflow(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const workflowName = normalizeWorkflowName(options.workflowName ?? "default");
  const workflowPath = path.join(projectRoot, ".aio", "workflows", workflowName);
  const workflow = readYamlFile(workflowPath);
  const config = readConfigFile(projectRoot);
  const projectKnowledge = { trackingFile: config?.tracking?.file ?? null };
  const states = workflow.states ?? {};
  let current = workflow.initial;
  const previousOutputs = {};
  const outputs = [];
  const maxSteps = options.maxSteps ?? 100;

  if (!current) {
    throw new Error(`${workflowPath} is missing an initial state.`);
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const state = states[current];
    if (!state) {
      throw new Error(`Workflow ${workflow.name ?? workflowName} references missing state ${current}.`);
    }

    if (state.type === "final") {
      return {
        workflow: workflow.name ?? path.basename(workflowName, ".yaml"),
        finalState: current,
        outputs,
        previousOutputs,
      };
    }

    if (!state.role) {
      throw new Error(`State ${current} must define a role or type: final.`);
    }

    const role = readRole(projectRoot, state.role);
    const git = getGitContext(projectRoot);
    const providerOutput = executeProvider({
      projectRoot,
      workflow: workflow.name ?? path.basename(workflowName, ".yaml"),
      stateName: current,
      roleName: state.role,
      role,
      previousOutputs,
      git,
      projectKnowledge,
    });

    previousOutputs[current] = providerOutput.output;
    previousOutputs[state.role] = providerOutput.output;
    outputs.push({
      state: current,
      role: state.role,
      provider: role.provider,
      output: providerOutput.output,
      stderr: providerOutput.stderr,
      status: providerOutput.status,
    });

    const completedState = current;
    current = resolveNextState(state.next ?? state.transitions, {
      git: getGitContext(projectRoot),
      previousOutputs,
    });

    if (!current) {
      throw new Error(`State ${completedState} did not resolve a next state.`);
    }
  }

  throw new Error(`Workflow ${workflow.name ?? workflowName} exceeded ${maxSteps} steps.`);
}

function normalizeWorkflowName(workflowName) {
  const stringName = String(workflowName || "default");
  return stringName.endsWith(".yaml") ? stringName : `${stringName}.yaml`;
}

function readRole(projectRoot, roleName) {
  const rolePath = path.join(projectRoot, ".aio", "roles", `${roleName}.yaml`);
  const role = readYamlFile(rolePath);

  if (!role.provider) {
    throw new Error(`${rolePath} must define provider.`);
  }

  return role;
}

function executeProvider({ projectRoot, workflow, stateName, roleName, role, previousOutputs, git, projectKnowledge }) {
  const providerName = role.provider;
  const providerPath = path.join(projectRoot, ".aio", "providers", `${providerName}.sh`);

  if (!fs.existsSync(providerPath)) {
    throw new Error(`Provider wrapper not found: ${providerPath}`);
  }

  const request = {
    workflow,
    state: stateName,
    role: roleName,
    provider: providerName,
    model: role.model ?? null,
    instructions: role.instructions ?? "",
    contextFiles: role.contextFiles ?? [],
    previousOutputs,
    git,
    projectKnowledge: projectKnowledge ?? { trackingFile: null },
  };

  const result = spawnSync(providerPath, [], {
    cwd: projectRoot,
    encoding: "utf8",
    input: JSON.stringify(request),
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stderr: result.stderr,
    output: normalizeProviderOutput(result.stdout),
  };
}

function normalizeProviderOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return { status: "empty", content: "" };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return { status: "ok", content: stdout };
  }

  return { status: "ok", content: stdout };
}

function resolveNextState(next, context) {
  if (typeof next === "string") {
    return next;
  }

  if (Array.isArray(next)) {
    for (const transition of next) {
      if (!transition.if || evaluateCondition(transition.if, context)) {
        return transition.then ?? transition.next;
      }
    }
    return null;
  }

  if (next && typeof next === "object") {
    if (!next.if || evaluateCondition(next.if, context)) {
      return next.then ?? next.next;
    }
  }

  return null;
}

function evaluateCondition(condition, context) {
  const trimmed = String(condition).trim();
  const equality = trimmed.match(/^([A-Za-z0-9_.-]+)\s*==\s*(true|false|null|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)$/);

  if (equality) {
    const actual = getDotPath(context, equality[1]);
    return actual === parseLiteral(equality[2]);
  }

  return Boolean(getDotPath(context, trimmed));
}

function parseLiteral(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return Number(value);
}

function getDotPath(context, dotPath) {
  const [first, ...rest] = String(dotPath).split(".");
  let current = first in context ? context[first] : context.previousOutputs?.[first];

  for (const segment of rest) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function getGitContext(projectRoot) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return {
    has_changes: result.status === 0 && result.stdout.trim().length > 0,
  };
}

function readYamlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }

  return YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {};
}

function readConfigFile(projectRoot) {
  const configPath = path.join(projectRoot, ".aio", "config.yaml");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {};
}

module.exports = {
  evaluateCondition,
  getGitContext,
  normalizeProviderOutput,
  normalizeWorkflowName,
  readConfigFile,
  resolveNextState,
  runWorkflow,
};
