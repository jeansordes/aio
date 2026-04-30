const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const YAML = require("yaml");

const CONFIG_TOP_LEVEL_KEYS = new Set([
  "version",
  "defaultWorkflow",
  "providersFile",
  "rolesDirectory",
  "workflowsDirectory",
  "defaults",
  "tracking",
  "workflow",
]);

async function runWorkflow(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const workflowName = normalizeWorkflowName(options.workflowName ?? "default");
  const workflowPath = path.join(projectRoot, ".aio", "workflows", workflowName);
  const workflow = readYamlFile(workflowPath);
  const config = readConfigFile(projectRoot);
  const providersConfig = readProvidersFile(projectRoot, config);
  const projectKnowledge = { trackingFile: config?.tracking?.file ?? null };
  const states = workflow.states ?? {};
  let current = workflow.initial;
  const steps = {};
  const outputs = [];
  const warn = typeof options.warn === "function" ? options.warn : (message) => console.warn(message);
  const maxSteps = options.maxSteps ?? config.workflow?.maxSteps ?? 100;
  const bus = options.bus;
  const allowEditsOutsideDir = Boolean(options.allowEditsOutsideDir);
  const abortSignal = options.abortSignal ?? null;
  /** @type {{ runId: string | null, runDir: string | null }} */
  const runContext = {
    runId: options.runId ?? null,
    runDir: options.runDir ?? null,
  };

  if (!current) {
    throw new Error(`${workflowPath} is missing an initial state.`);
  }

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      const state = states[current];
      if (!state) {
        throw new Error(`Workflow ${workflow.name ?? workflowName} references missing state ${current}.`);
      }

      if (state.type === "final") {
        bus?.emit?.("runEnd", { finalState: current });
        return {
          workflow: workflow.name ?? path.basename(workflowName, ".yaml"),
          finalState: current,
          outputs,
          steps,
        };
      }

      if (!state.role) {
        throw new Error(`State ${current} must define a role or type: final.`);
      }

      const role = readRole(projectRoot, state.role);
      const git = getGitContext(projectRoot);
      const workflowLabel = workflow.name ?? path.basename(workflowName, ".yaml");

      bus?.emit?.("stateEnter", {
        stateName: current,
        roleName: state.role,
        providerName: role.provider,
      });

      const stepStarted = Date.now();
      const providerOutput = await executeProvider({
        projectRoot,
        workflow: workflowLabel,
        stateName: current,
        roleName: state.role,
        role,
        git,
        projectKnowledge,
        providersConfig,
        warn,
        bus,
        phase: "main",
        allowEditsOutsideDir,
        abortSignal,
        runContext,
      });

      const stepDurationMs = Date.now() - stepStarted;

      bus?.emit?.("stepMilestone", {
        stateName: current,
        roleName: state.role,
        providerName: role.provider,
        status: providerOutput.step.status,
        exit_code: providerOutput.step.exit_code,
        durationMs: stepDurationMs,
        changed_files: providerOutput.step.changed_files,
      });

      steps[current] = providerOutput.step;
      steps[state.role] = providerOutput.step;
      outputs.push({
        state: current,
        role: state.role,
        provider: role.provider,
        stdout: providerOutput.stdout,
        stderr: providerOutput.stderr,
        status: providerOutput.step.status,
        exit_code: providerOutput.step.exit_code,
        has_changes: providerOutput.step.has_changes,
        changed_files: providerOutput.step.changed_files,
        step: providerOutput.step,
      });

      const completedState = current;
      const nextState = resolveNextState(
        state.next ?? state.transitions,
        {
          git: getGitContext(projectRoot),
          step: providerOutput.step,
          steps,
        },
        { warn },
      );

      if (!nextState) {
        throw new Error(`State ${completedState} did not resolve a next state.`);
      }

      bus?.emit?.("transition", { from: completedState, to: nextState });
      current = nextState;
    }

    throw new Error(`Workflow ${workflow.name ?? workflowName} exceeded ${maxSteps} steps.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus?.emit?.("runError", { message });
    throw err;
  }
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

/**
 * @param {object} params
 * @param {string} [params.phase]
 * @param {import('node:events').EventEmitter} [params.bus]
 * @param {string} [params.promptOverride]
 * @param {boolean} [params.allowEditsOutsideDir]
 * @param {AbortSignal | null} [params.abortSignal]
 * @param {{ runId: string | null, runDir: string | null }} [params.runContext]
 */
function executeProvider(params) {
  const {
    projectRoot,
    workflow,
    stateName,
    roleName,
    role,
    git,
    projectKnowledge,
    providersConfig,
    bus,
    phase = "main",
    promptOverride,
    allowEditsOutsideDir = false,
    abortSignal = null,
    runContext = { runId: null, runDir: null },
  } = params;
  const providerName = role.provider;
  const provider = providersConfig.providers?.[providerName];
  const before = getWorkingTreeSnapshot(projectRoot);

  if (!provider || provider.status === "not_configured" || !provider.command) {
    const message = provider?.message ?? `Provider ${providerName} is not configured. Edit .aio/providers.yaml.`;
    const after = getWorkingTreeSnapshot(projectRoot);
    const out = providerResult({
      before,
      after,
      stdout: message,
      stderr: "",
      exitCode: null,
      status: "not_configured",
    });
    bus?.emit?.("providerExit", {
      stateName,
      roleName,
      phase,
      status: out.step.status,
      exit_code: out.step.exit_code,
      durationMs: 0,
      changed_files: out.step.changed_files,
    });
    return Promise.resolve(out);
  }

  const prompt =
    promptOverride ??
    buildPrompt({
      workflow,
      stateName,
      roleName,
      role,
      git,
      projectKnowledge: projectKnowledge ?? { trackingFile: null },
      promptConfig: provider.prompt,
      runId: runContext.runId,
      runDir: runContext.runDir,
    });
  const args = buildProviderArgs(provider, {
    prompt,
    model: role.model ?? "default",
    projectRoot,
    allowEditsOutsideDir,
  });

  const providerCommandLabel = `${provider.command} ${(args ?? []).join(" ")}`.slice(0, 400);
  const started = Date.now();
  bus?.emit?.("providerStart", {
    stateName,
    roleName,
    phase,
    providerCommand: providerCommandLabel,
  });

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(provider.command, args, {
      cwd: projectRoot,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: projectRoot },
    });

    function killProvider() {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    }

    function onAbortSignal() {
      killProvider();
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbortSignal();
      } else {
        abortSignal.addEventListener("abort", onAbortSignal, { once: true });
      }
    }
    bus?.on?.("abortRequested", onAbortSignal);

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      bus?.emit?.("providerStdout", { stateName, roleName, phase, chunk });
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      bus?.emit?.("providerStderr", { stateName, roleName, phase, chunk });
    });

    child.stdin?.end();

    function cleanupAbortListeners() {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbortSignal);
      }
      bus?.off?.("abortRequested", onAbortSignal);
    }

    function finish(after, exitCode, status) {
      settled = true;
      cleanupAbortListeners();
      const out = providerResult({
        before,
        after,
        stdout,
        stderr,
        exitCode,
        status,
      });
      bus?.emit?.("providerExit", {
        stateName,
        roleName,
        phase,
        status: out.step.status,
        exit_code: out.step.exit_code,
        durationMs: Date.now() - started,
        changed_files: out.step.changed_files,
      });
      resolve(out);
    }

    child.on("error", (err) => {
      settled = true;
      cleanupAbortListeners();
      const after = getWorkingTreeSnapshot(projectRoot);
      const msg = err instanceof Error ? err.message : String(err);
      const out = providerResult({
        before,
        after,
        stdout,
        stderr: `${stderr}${msg}`,
        exitCode: null,
        status: "failed",
      });
      bus?.emit?.("providerExit", {
        stateName,
        roleName,
        phase,
        status: out.step.status,
        exit_code: out.step.exit_code,
        durationMs: Date.now() - started,
        changed_files: out.step.changed_files,
      });
      resolve(out);
    });

    child.on("close", (code) => {
      if (settled) return;
      const after = getWorkingTreeSnapshot(projectRoot);
      const okExitCodes = provider.success?.exit_codes ?? [0];
      const status = okExitCodes.includes(code) ? "ok" : "failed";
      finish(after, code, status);
    });
  });
}

function providerResult({ before, after, stdout, stderr, exitCode, status }) {
  const changedFiles = compareWorkingTreeSnapshots(before, after);
  return {
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    step: {
      status,
      exit_code: exitCode,
      has_changes: changedFiles.length > 0,
      changed_files: changedFiles,
    },
  };
}

function buildProviderArgs(provider, values) {
  const args = [];
  for (const arg of provider.args ?? []) {
    if (arg === "{{model_args}}") {
      const model = values.model;
      if (model && model !== "default") {
        for (const modelArg of provider.modelArgs ?? provider.model?.args ?? []) {
          args.push(renderTemplate(modelArg, values));
        }
      }
      continue;
    }
    if (arg === "{{isolation_args}}") {
      if (!values.allowEditsOutsideDir && provider.isolationArgs?.length) {
        for (const iso of provider.isolationArgs) {
          args.push(renderTemplate(iso, values));
        }
      }
      continue;
    }
    args.push(renderTemplate(arg, values));
  }
  return args;
}

function renderTemplate(value, values) {
  return String(value)
    .replaceAll("{{prompt}}", values.prompt ?? "")
    .replaceAll("{{model}}", values.model ?? "")
    .replaceAll("{{project_root}}", values.projectRoot ?? "");
}

function buildPrompt({
  workflow,
  stateName,
  roleName,
  role,
  git,
  projectKnowledge,
  promptConfig,
  runId = null,
  runDir = null,
}) {
  const include = promptConfig?.include ?? ["instructions", "tracking_file", "context_files"];
  const sections = [];

  if (include.includes("instructions") && role.instructions) {
    sections.push(role.instructions);
  }
  if (include.includes("tracking_file") && projectKnowledge?.trackingFile) {
    sections.push(`Tracking file: ${projectKnowledge.trackingFile}`);
  }
  if (include.includes("context_files") && role.contextFiles?.length) {
    sections.push(`Context files:\n${role.contextFiles.join("\n")}`);
  }
  if (include.includes("run_dir") && runId && runDir) {
    sections.push(
      [`Run id: ${runId}`, `Run directory: ${runDir}`, `Latest pointer: .aio/runs/latest`].join("\n"),
    );
  }
  if (include.includes("runtime")) {
    sections.push(
      [
        `Workflow: ${workflow}`,
        `State: ${stateName}`,
        `Role: ${roleName}`,
        `Git has changes: ${Boolean(git?.has_changes)}`,
      ].join("\n"),
    );
  }

  return sections.filter(Boolean).join("\n\n");
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

  if (!inContext) {
    return { value: undefined, missing: true };
  }

  let current = context[first];

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

function getWorkingTreeSnapshot(projectRoot) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return { available: false, files: new Map() };
  }

  const files = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    const filePath = normalizeStatusPath(line.slice(3));
    files.set(filePath, `${status}:${fingerprintPath(path.join(projectRoot, filePath))}`);
  }

  return { available: true, files };
}

function normalizeStatusPath(statusPath) {
  const renameSeparator = " -> ";
  if (statusPath.includes(renameSeparator)) {
    return statusPath.slice(statusPath.lastIndexOf(renameSeparator) + renameSeparator.length);
  }
  return statusPath;
}

function fingerprintPath(filePath) {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return `dir:${stat.mtimeMs}`;
  }

  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `file:${stat.size}:${hash.digest("hex")}`;
}

function compareWorkingTreeSnapshots(before, after) {
  if (!before.available || !after.available) {
    return [];
  }

  const changed = [];
  const files = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const file of files) {
    if (before.files.get(file) !== after.files.get(file)) {
      changed.push(file);
    }
  }
  return changed.sort();
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

  if (config.providersFile != null && typeof config.providersFile !== "string") {
    throw new Error(`Invalid config: "providersFile" must be a string in ${configPath}.`);
  }

  if (config.defaults !== undefined) {
    if (config.defaults == null || typeof config.defaults !== "object" || Array.isArray(config.defaults)) {
      throw new Error(`Invalid config: "defaults" must be an object in ${configPath}.`);
    }
    if (config.defaults.provider != null && typeof config.defaults.provider !== "string") {
      throw new Error(`Invalid config: "defaults.provider" must be a string or null in ${configPath}.`);
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

function readProvidersFile(projectRoot, config = {}) {
  const providersPath = path.join(projectRoot, ".aio", config.providersFile ?? "providers.yaml");
  const providersConfig = readYamlFile(providersPath);
  validateProvidersConfig(providersConfig, providersPath);
  return providersConfig;
}

function validateProvidersConfig(config, configPath) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid providers config: expected a mapping in ${configPath}.`);
  }
  if (config.providers == null || typeof config.providers !== "object" || Array.isArray(config.providers)) {
    throw new Error(`Invalid providers config: "providers" must be an object in ${configPath}.`);
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider == null || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`Invalid providers config: provider "${name}" must be an object in ${configPath}.`);
    }
    if (provider.command != null && typeof provider.command !== "string") {
      throw new Error(`Invalid providers config: provider "${name}".command must be a string in ${configPath}.`);
    }
    if (provider.args != null && !Array.isArray(provider.args)) {
      throw new Error(`Invalid providers config: provider "${name}".args must be an array in ${configPath}.`);
    }
    if (provider.isolationArgs != null) {
      if (!Array.isArray(provider.isolationArgs)) {
        throw new Error(`Invalid providers config: provider "${name}".isolationArgs must be an array in ${configPath}.`);
      }
      for (const entry of provider.isolationArgs) {
        if (typeof entry !== "string") {
          throw new Error(
            `Invalid providers config: provider "${name}".isolationArgs must contain only strings in ${configPath}.`,
          );
        }
      }
    }
  }
}

module.exports = {
  buildProviderArgs,
  buildPrompt,
  compareWorkingTreeSnapshots,
  evaluateCondition,
  getGitContext,
  getDotPath,
  getWorkingTreeSnapshot,
  normalizeProviderOutput,
  normalizeWorkflowName,
  readProvidersFile,
  readConfigFile,
  resolveDotPath,
  resolveNextState,
  runWorkflow,
};
