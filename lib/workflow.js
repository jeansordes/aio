const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");

const CONFIG_TOP_LEVEL_KEYS = new Set([
  "version",
  "defaultWorkflow",
  "providersDirectory",
  "rolesDirectory",
  "workflowsDirectory",
  "tracking",
  "workflow",
]);

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
  const warn = typeof options.warn === "function" ? options.warn : (message) => console.warn(message);
  const maxSteps = options.maxSteps ?? config.workflow?.maxSteps ?? 100;

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
      warn,
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
    current = resolveNextState(
      state.next ?? state.transitions,
      {
        git: getGitContext(projectRoot),
        previousOutputs,
      },
      { warn },
    );

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

function executeProvider({ projectRoot, workflow, stateName, roleName, role, previousOutputs, git, projectKnowledge, warn }) {
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
    output: normalizeProviderOutput(result.stdout, { warn }),
  };
}

function normalizeProviderOutput(stdout, options = {}) {
  const warn = typeof options.warn === "function" ? options.warn : (message) => console.warn(message);
  const fallback = { status: "ok", content: stdout };
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return { status: "empty", content: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    warn(
      `aio: provider output was not valid JSON (${err instanceof Error ? err.message : String(err)}). Preview: ${preview}`,
    );
    return fallback;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }

  warn("aio: provider JSON was parsed but a plain object was expected; wrapping raw stdout as content.");
  return fallback;
}

function resolveNextState(next, context, options = {}) {
  const warn = typeof options.warn === "function" ? options.warn : () => {};
  if (typeof next === "string") {
    return next;
  }

  if (Array.isArray(next)) {
    for (const transition of next) {
      if (!transition.if || evaluateCondition(transition.if, context, { warn })) {
        return transition.then ?? transition.next;
      }
    }
    return null;
  }

  if (next && typeof next === "object") {
    if (!next.if || evaluateCondition(next.if, context, { warn })) {
      return next.then ?? next.next;
    }
  }

  return null;
}

function evaluateCondition(condition, context, options = {}) {
  const warn = typeof options.warn === "function" ? options.warn : () => {};
  const trimmed = String(condition).trim();
  const equality = trimmed.match(/^([A-Za-z0-9_.-]+)\s*==\s*(true|false|null|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)$/);

  if (equality) {
    const pathStr = equality[1];
    const { value: actual, missing } = resolveDotPath(context, pathStr);
    if (missing) {
      warn(`aio: workflow condition references missing path: ${pathStr} (in "${trimmed}").`);
    }
    return actual === parseLiteral(equality[2]);
  }

  const { value, missing } = resolveDotPath(context, trimmed);
  if (missing) {
    warn(`aio: workflow condition references missing path: ${trimmed}.`);
  }
  return Boolean(value);
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

const hop = Object.prototype.hasOwnProperty;

/**
 * @returns {{ value: unknown, missing: boolean }}
 */
function resolveDotPath(context, dotPath) {
  const [first, ...rest] = String(dotPath).split(".");
  const inContext = first in context;
  const inOutputs = context.previousOutputs != null && first in context.previousOutputs;

  if (!inContext && !inOutputs) {
    return { value: undefined, missing: true };
  }

  let current = inContext ? context[first] : context.previousOutputs[first];

  for (const segment of rest) {
    if (current == null || typeof current !== "object") {
      return { value: undefined, missing: true };
    }
    if (!hop.call(current, segment)) {
      return { value: undefined, missing: true };
    }
    current = current[segment];
  }

  return { value: current, missing: false };
}

function getDotPath(context, dotPath) {
  return resolveDotPath(context, dotPath).value;
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

function validateAioConfig(config, configPath) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config: expected a mapping in ${configPath}.`);
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_TOP_LEVEL_KEYS.has(key)) {
      const allowed = [...CONFIG_TOP_LEVEL_KEYS].sort().join(", ");
      throw new Error(`Invalid config: unknown key "${key}" in ${configPath}. Allowed: ${allowed}.`);
    }
  }

  if (config.tracking !== undefined) {
    if (config.tracking == null || typeof config.tracking !== "object" || Array.isArray(config.tracking)) {
      throw new Error(`Invalid config: "tracking" must be an object in ${configPath}.`);
    }
    if (config.tracking.file != null && typeof config.tracking.file !== "string") {
      throw new Error(`Invalid config: "tracking.file" must be a string or null in ${configPath}.`);
    }
  }

  if (config.workflow !== undefined) {
    if (config.workflow == null || typeof config.workflow !== "object" || Array.isArray(config.workflow)) {
      throw new Error(`Invalid config: "workflow" must be an object in ${configPath}.`);
    }
    if (config.workflow.maxSteps != null) {
      const m = config.workflow.maxSteps;
      if (!Number.isInteger(m) || m < 1) {
        throw new Error(`Invalid config: "workflow.maxSteps" must be a positive integer in ${configPath}.`);
      }
    }
  }
}

function readConfigFile(projectRoot) {
  const configPath = path.join(projectRoot, ".aio", "config.yaml");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid config: expected a mapping in ${configPath}.`);
  }
  validateAioConfig(raw, configPath);
  return raw;
}

module.exports = {
  evaluateCondition,
  getGitContext,
  getDotPath,
  normalizeProviderOutput,
  normalizeWorkflowName,
  readConfigFile,
  resolveDotPath,
  resolveNextState,
  runWorkflow,
};
