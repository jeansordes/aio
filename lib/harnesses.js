const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const YAML = require("yaml");
const { validateNotifications } = require("./notifications");

const builtins = {
  cursor: {
    command: "cursor-agent",
    args: ["-p", "--force", "--trust", "--output-format", "stream-json",
      "--stream-partial-output", "--workspace", "{{project_root}}", "--sandbox", "enabled",
      "{{model_args}}", "{{prompt}}"],
    modelArgs: ["--model", "{{model}}"],
  },
  codex: {
    command: "codex",
    args: ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "{{model_args}}", "-"],
    promptInput: "stdin",
    modelArgs: ["--model", "{{model}}"],
  },
};

function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "aio", "config.yaml");
}

const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function keys(value, allowed, label) {
  check(mapping(value), `${label} must be a mapping.`);
  for (const key of Object.keys(value)) check(allowed.includes(key), `Unknown ${label} field: ${key}`);
}

function validateConfig(config) {
  keys(config, ["harnesses", "notifications"], "config");
  if (config.harnesses !== undefined) check(mapping(config.harnesses), "harnesses must be a mapping.");
  const harnesses = { ...builtins, ...config.harnesses };
  for (const [id, harness] of Object.entries(harnesses)) {
    check(/^[a-zA-Z0-9_-]+$/.test(id), `Invalid harness id: ${id}`);
    keys(harness, ["command", "args", "modelArgs", "promptInput", "successExitCodes"], `harness ${id}`);
    check(nonempty(harness.command), `Harness ${id} needs a command.`);
    check(Array.isArray(harness.args) && harness.args.every((v) => typeof v === "string"), `Invalid args for ${id}.`);
    check(harness.promptInput === undefined || harness.promptInput === "stdin", `Invalid promptInput for ${id}.`);
    check(harness.promptInput === "stdin" || harness.args.some((v) => v.includes("{{prompt}}")),
      `Harness ${id} must accept the prompt through stdin or {{prompt}}.`);
    if (harness.modelArgs !== undefined) {
      check(Array.isArray(harness.modelArgs) && harness.modelArgs.every((v) => typeof v === "string"),
        `Invalid modelArgs for ${id}.`);
    }
    if (harness.successExitCodes !== undefined) {
      check(Array.isArray(harness.successExitCodes) && harness.successExitCodes.length > 0 &&
        harness.successExitCodes.every(Number.isInteger), `Invalid successExitCodes for ${id}.`);
    }
  }
  validateNotifications(config.notifications);
  return config;
}

function loadHarnesses(env = process.env) {
  const file = configPath(env);
  let config = {};
  try { config = YAML.parse(fs.readFileSync(file, "utf8")) ?? {}; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  validateConfig(config);
  const harnesses = structuredClone({ ...builtins, ...config.harnesses });
  for (const harness of Object.values(harnesses)) {
    if (/[/\\]/.test(harness.command) && !path.isAbsolute(harness.command)) {
      harness.command = path.resolve(path.dirname(file), harness.command);
    }
  }
  return { file, config, harnesses };
}

function saveConfig(loaded) {
  const config = { ...loaded.config };
  validateConfig(config);
  fs.mkdirSync(path.dirname(loaded.file), { recursive: true, mode: 0o700 });
  const tmp = loaded.file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, YAML.stringify(config), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, loaded.file);
  } finally { fs.rmSync(tmp, { force: true }); }
  loaded.config = config;
}

function available(harness, env = process.env) {
  const dirs = /[/\\]/.test(harness.command) ? [""] : (env.PATH ?? "").split(path.delimiter);
  const extensions = process.platform === "win32" && !path.extname(harness.command)
    ? (env.PATHEXT ?? ".EXE;.COM").split(";") : [""];
  return dirs.some((dir) => extensions.some((ext) => {
    try {
      const candidate = path.resolve(dir, harness.command + ext);
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  }));
}

function resolveHarness(entry, loaded, env = process.env) {
  const id = entry.harness;
  check(Object.hasOwn(loaded.harnesses, id), `Unknown harness: ${id}`);
  const harness = loaded.harnesses[id];
  check(available(harness, env), `Harness ${id} is unavailable. Check ${loaded.file} and PATH.`);
  const model = entry.model;
  check(nonempty(model), `Harness ${id} needs an explicit model identifier.`);
  if (model) check(harness.args.includes("{{model_args}}") && harness.modelArgs?.some((v) => v.includes("{{model}}")) ||
    harness.args.some((v) => v.includes("{{model}}")), `Harness ${id} has no model argument configuration.`);
  return { ...harness, id, model };
}

function harnessArgs(harness, { prompt, projectRoot }) {
  const slots = { prompt, project_root: projectRoot, model: harness.model ?? "" };
  const render = (v) => v.replace(/\{\{(prompt|model|project_root)\}\}/g, (_, key) => slots[key]);
  return harness.args.flatMap((arg) => arg === "{{model_args}}"
    ? (harness.model ? (harness.modelArgs ?? []).map(render) : []) : [render(arg)]);
}

module.exports = { configPath, loadHarnesses, saveConfig, available, resolveHarness, harnessArgs, mapping, nonempty, check, keys };
