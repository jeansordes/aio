const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createStyle, writeDetectedProviders, writeInitIntro } = require("./init-ui");
const { mergeEnvFile } = require("./env-file");

const PROVIDERS = ["cursor", "codex", "claude", "gemini", "opencode", "custom"];
const ROLES = ["pick", "do", "eval"];
const TRACKING_CANDIDATES = ["specs/roadmap.csv", "TASKS.md", "ROADMAP.md"];

const DEFAULT_WORKFLOW_RELATIVE = path.join("templates", "default-workflow");

/**
 * Declarative providers aio probes at init (`command` + `args`, exit 0 => detected).
 * Order defines priority when multiple CLIs match non-interactive runs (first wins).
 */
const PROVIDER_PROBE_CATALOG = [
  { name: "cursor", command: "cursor-agent", args: ["--version"] },
  { name: "codex", command: "codex", args: ["--version"] },
  { name: "claude", command: "claude", args: ["--version"] },
  { name: "gemini", command: "gemini", args: ["--version"] },
  { name: "opencode", command: "opencode", args: ["--version"] },
];

const INIT_NO_PROVIDER_ERROR = `aio: cannot run without a local LLM provider CLI. Install the Cursor Agent CLI and ensure cursor-agent is on your PATH, or add a command under a provider in .aio/providers.yaml (for example the custom entry) once you can invoke an AI CLI from this machine.`;

/**
 * @returns {string}
 */
function getDefaultWorkflowTemplateRoot() {
  return path.join(__dirname, "..", DEFAULT_WORKFLOW_RELATIVE);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listTemplateFilesRecursive(root) {
  const out = [];
  if (!fs.existsSync(root)) {
    return out;
  }
  function walk(current) {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else {
        out.push(path.relative(root, p));
      }
    }
  }
  walk(root);
  return out.sort();
}

/**
 * @param {string} trackingFile
 * @returns {string}
 */
function formatTrackingFileYaml(trackingFile) {
  return trackingFile == null ? "null" : trackingFile;
}

/**
 * @param {string} filePath
 * @param {string} defaultProvider
 * @returns {string}
 */
function renderTemplateFile(filePath, defaultProvider) {
  return fs.readFileSync(filePath, "utf8").replaceAll("__AIO_DEFAULT_PROVIDER__", defaultProvider);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function renderConfigOnly(filePath, trackingFileYaml, defaultProvider) {
  let body = fs.readFileSync(filePath, "utf8");
  body = body.replaceAll("__AIO_TRACKING_FILE__", trackingFileYaml);
  body = body.replaceAll("__AIO_DEFAULT_PROVIDER__", defaultProvider);
  return body;
}

/**
 * @param {string} projectRoot
 * @param {{ defaultProvider: string, trackingFile: string | null }} values
 * @param {string[]} created
 * @param {string[]} skipped
 */
function applyDefaultWorkflowTemplate(projectRoot, { defaultProvider, trackingFile }, created, skipped) {
  const templateRoot = getDefaultWorkflowTemplateRoot();
  if (!fs.existsSync(templateRoot)) {
    throw new Error(`aio: missing default workflow template at ${templateRoot}`);
  }

  const relPaths = listTemplateFilesRecursive(templateRoot);
  if (relPaths.length === 0) {
    throw new Error(`aio: default workflow template is empty: ${templateRoot}`);
  }

  const trackingFileYaml = formatTrackingFileYaml(trackingFile);

  for (const rel of relPaths) {
    const src = path.join(templateRoot, rel);
    const dest = path.join(projectRoot, ".aio", rel);
    ensureDirectory(path.dirname(dest), created);

    let content;
    if (path.basename(src) === "config.yaml") {
      content = renderConfigOnly(src, trackingFileYaml, defaultProvider);
    } else {
      content = renderTemplateFile(src, defaultProvider);
    }
    writeFileIfMissing(dest, content, created, skipped);
  }
}

/**
 * @param {object} [options]
 * @param {() => string[] | null | undefined} [options.probeProviders] — tests: return detected provider ids (same ids as providers.yaml keys)
 * @param {() => string | null} [options.probeProvider] — legacy tests: single provider or null
 * @returns {string[]}
 */
function detectInstalledProviders(options = {}) {
  if (typeof options.probeProviders === "function") {
    const list = options.probeProviders();
    return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.length > 0) : [];
  }
  if (typeof options.probeProvider === "function") {
    const one = options.probeProvider();
    return one ? [one] : [];
  }
  const detected = [];
  for (const entry of PROVIDER_PROBE_CATALOG) {
    const result = spawnSync(entry.command, entry.args, {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      detected.push(entry.name);
    }
  }
  return detected;
}

/**
 * @param {object} [options]
 * @returns {string | null}
 */
function detectInstalledProvider(options = {}) {
  const found = detectInstalledProviders(options);
  return found[0] ?? null;
}

/**
 * @param {object} params
 * @param {string[]} params.detected
 * @param {{ name: string, command: string, args: string[] }[]} params.catalog
 * @returns {Promise<string>}
 */
function getInquirer(options) {
  return options.inquirer ?? require("@inquirer/prompts");
}

async function chooseDefaultProviderInteractive({ detected, catalog, stdin, stdout, inquirer: inq }) {
  const useColor = Boolean(stdout.isTTY);
  const style = createStyle(useColor);
  writeDetectedProviders(stdout, style, catalog, detected);

  const { select } = getInquirer({ inquirer: inq });
  const choice = await select(
    {
      message: "Default provider for roles and workflows",
      choices: detected.map((name) => ({ name, value: name })),
      default: detected[0],
    },
    { input: stdin, output: stdout },
  );
  return choice;
}

/**
 * @param {object} options
 * @param {string[]} detected
 * @param {boolean} interactive
 */
async function resolveDefaultProvider(options, detected, interactive) {
  if (detected.length === 0) {
    return null;
  }

  const explicit =
    options.defaultProvider != null && options.defaultProvider !== ""
      ? String(options.defaultProvider)
      : null;
  if (explicit != null) {
    if (!detected.includes(explicit)) {
      throw new Error(
        `aio: default provider "${explicit}" is not among detected providers (${detected.join(", ")}).`,
      );
    }
    return explicit;
  }

  const envPick =
    typeof process.env.AIO_DEFAULT_PROVIDER === "string" && process.env.AIO_DEFAULT_PROVIDER.trim() !== ""
      ? process.env.AIO_DEFAULT_PROVIDER.trim()
      : null;
  if (envPick != null && detected.includes(envPick)) {
    return envPick;
  }

  if (interactive && detected.length > 1) {
    return chooseDefaultProviderInteractive({
      detected,
      catalog: PROVIDER_PROBE_CATALOG,
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      inquirer: options.inquirer,
    });
  }

  if (interactive && detected.length === 1) {
    const style = createStyle(Boolean((options.stdout ?? process.stdout).isTTY));
    writeDetectedProviders(options.stdout ?? process.stdout, style, PROVIDER_PROBE_CATALOG, detected);
  }

  return detected[0];
}

async function setupProject(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;
  const interactive = Boolean(stdinIsTTY && stdoutIsTTY);

  let trackingFile = options.trackingFile;
  let scaffoldSpecs = options.scaffoldSpecs;

  if (trackingFile === undefined || scaffoldSpecs === undefined) {
    const choice = await chooseTrackingFile({
      projectRoot,
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      interactive,
      inquirer: options.inquirer,
    });
    if (trackingFile === undefined) trackingFile = choice.file;
    if (scaffoldSpecs === undefined) scaffoldSpecs = choice.scaffoldSpecs;
  }

  if (scaffoldSpecs && !trackingFile) {
    trackingFile = "specs/roadmap.csv";
  }

  const detected = detectInstalledProviders(options);
  const defaultProvider = await resolveDefaultProvider(options, detected, interactive);
  if (!defaultProvider) {
    throw new Error(INIT_NO_PROVIDER_ERROR);
  }

  const created = [];
  const skipped = [];

  ensureDirectory(path.join(projectRoot, ".aio"), created);
  applyDefaultWorkflowTemplate(
    projectRoot,
    { defaultProvider, trackingFile: trackingFile ?? null },
    created,
    skipped,
  );

  ensureEmptyProjectAgentsMd(projectRoot, created);

  if (scaffoldSpecs) {
    scaffoldSpecsStructure(projectRoot, created, skipped);
  }

  let discordConfigured = false;
  if (interactive) {
    discordConfigured = await promptDiscordWebhook({
      projectRoot,
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      inquirer: options.inquirer,
    });
  }

  return {
    projectRoot,
    created,
    skipped,
    scaffoldSpecs,
    trackingFile: trackingFile ?? null,
    defaultProvider,
    discordConfigured,
  };
}

function scaffoldSpecsStructure(projectRoot, created, skipped) {
  ensureDirectory(path.join(projectRoot, "specs"), created);
  for (const directory of ["00-domains", "01-features", "02-requirements"]) {
    ensureDirectory(path.join(projectRoot, "specs", directory), created);
  }

  writeFileIfMissing(
    path.join(projectRoot, "specs", "roadmap.csv"),
    "id,level,parent_id,title,path,first_implemented_in_version,last_impacted_in_version,status,priority,blocked_by,notes\n",
    created,
    skipped,
  );
}

function detectTrackingCandidate(projectRoot) {
  return TRACKING_CANDIDATES.find((relative) => fs.existsSync(path.join(projectRoot, relative))) ?? null;
}

async function chooseTrackingFile({ projectRoot, stdin, stdout, interactive, inquirer: inq }) {
  const detected = detectTrackingCandidate(projectRoot);

  if (!interactive) {
    return { file: detected, scaffoldSpecs: false };
  }

  const useColor = Boolean(stdout.isTTY);
  const style = createStyle(useColor);
  const defaultDescription = detected
    ? `Keep ${style.bold(detected)} (no new specs/ folders).`
    : `Scaffold ${style.bold("specs/")} + ${style.bold("specs/roadmap.csv")} and use that as tracking (recommended).`;

  writeInitIntro(stdout, style, { detected, defaultDescription });

  const { select, input } = getInquirer({ inquirer: inq });
  /** @type {{ name: string, value: string, disabled?: string | boolean }[]} */
  const choices = [
    {
      name: detected ? `Keep detected file (${detected})` : "Keep detected file (none found)",
      value: "keep",
      disabled: detected ? false : "(no tracker detected)",
    },
    { name: "Scaffold specs/ + specs/roadmap.csv (Johnny Decimal layout)", value: "scaffold" },
    { name: "No tracking file (tracking.file: null)", value: "none" },
    { name: "Custom relative path", value: "custom" },
  ];

  const initial = detected ? "keep" : "scaffold";
  const mode = await select(
    {
      message: "How should aio track tasks / roadmap?",
      choices,
      default: initial,
    },
    { input: stdin, output: stdout },
  );

  if (mode === "keep") {
    return { file: detected, scaffoldSpecs: false };
  }
  if (mode === "scaffold") {
    return { file: "specs/roadmap.csv", scaffoldSpecs: true };
  }
  if (mode === "none") {
    return { file: null, scaffoldSpecs: false };
  }
  const customPath = await input(
    {
      message: "Relative path to your tracker file",
      validate: (v) => (v && v.trim() ? true : "Enter a non-empty path"),
    },
    { input: stdin, output: stdout },
  );
  return { file: customPath.trim(), scaffoldSpecs: false };
}

/**
 * @returns {Promise<boolean>} true when a webhook URL was saved
 */
async function promptDiscordWebhook({ projectRoot, stdin, stdout, inquirer: inq }) {
  const { confirm, input } = getInquirer({ inquirer: inq });
  const add = await confirm(
    {
      message: "Add a Discord webhook URL for aio run notifications?",
      default: false,
    },
    { input: stdin, output: stdout },
  );
  if (!add) {
    return false;
  }
  const url = await input(
    {
      message: "Discord webhook URL (https://discord.com/api/webhooks/...)",
      validate: (v) => {
        const t = (v ?? "").trim();
        if (!t) return "URL is required";
        if (!t.startsWith("https://")) return "URL must start with https://";
        return true;
      },
    },
    { input: stdin, output: stdout },
  );
  const mention = await input(
    {
      message: "Optional Discord user id to @mention on alerts (leave empty to skip)",
      default: "",
    },
    { input: stdin, output: stdout },
  );
  const entries = { DISCORD_WEBHOOK_URL: url.trim() };
  const m = mention.trim();
  if (m) {
    entries.DISCORD_MENTION_USER_ID = m;
  }
  mergeEnvFile(projectRoot, entries);
  return true;
}

function ensureDirectory(directoryPath, created) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    created.push(directoryPath);
    return;
  }

  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`${directoryPath} exists and is not a directory.`);
  }
}

function writeFileIfMissing(filePath, content, created, skipped, options = {}) {
  if (fs.existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }

  fs.writeFileSync(filePath, content, { mode: options.mode });
  created.push(filePath);
}

/**
 * @param {string} startDir
 * @returns {string | null} absolute path to nearest .git directory parent, or null
 */
function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * @param {string} projectRoot
 */
function isNestedInOtherGitRepo(projectRoot) {
  const root = findGitRoot(projectRoot);
  return Boolean(root && root !== path.resolve(projectRoot));
}

/**
 * Walk parents of projectRoot (not including projectRoot) for AGENTS.md
 * @param {string} projectRoot
 */
function ancestorPathHasAgentsMd(projectRoot) {
  let dir = path.dirname(path.resolve(projectRoot));
  while (true) {
    if (fs.existsSync(path.join(dir, "AGENTS.md"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

/**
 * When nested in a parent repo or when an ancestor has AGENTS.md, add an empty
 * project AGENTS.md so agent CLIs stop at this directory.
 * @param {string} projectRoot
 * @param {string[]} [created]
 */
function ensureEmptyProjectAgentsMd(projectRoot, created) {
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    return;
  }
  const needs = isNestedInOtherGitRepo(projectRoot) || ancestorPathHasAgentsMd(projectRoot);
  if (!needs) {
    return;
  }
  fs.writeFileSync(agentsPath, "", "utf8");
  if (created) {
    created.push(agentsPath);
  }
}

function configTemplate(trackingFile, defaultProvider = "cursor") {
  const configPath = path.join(getDefaultWorkflowTemplateRoot(), "config.yaml");
  const trackingFileYaml = formatTrackingFileYaml(trackingFile);
  return renderConfigOnly(configPath, trackingFileYaml, defaultProvider);
}

function providersConfigTemplate() {
  const p = path.join(getDefaultWorkflowTemplateRoot(), "providers.yaml");
  return fs.readFileSync(p, "utf8");
}

function defaultWorkflowTemplate() {
  const p = path.join(getDefaultWorkflowTemplateRoot(), "workflows", "default.yaml");
  return fs.readFileSync(p, "utf8");
}

function roleTemplate(role, providerName) {
  const p = path.join(getDefaultWorkflowTemplateRoot(), "roles", `${role}.yaml`);
  if (!fs.existsSync(p)) {
    throw new Error(`aio: missing role template: ${p}`);
  }
  return renderTemplateFile(p, providerName);
}

module.exports = {
  PROVIDERS,
  ROLES,
  TRACKING_CANDIDATES,
  PROVIDER_PROBE_CATALOG,
  INIT_NO_PROVIDER_ERROR,
  ancestorPathHasAgentsMd,
  chooseTrackingFile,
  configTemplate,
  defaultWorkflowTemplate,
  detectInstalledProviders,
  detectInstalledProvider,
  detectTrackingCandidate,
  ensureEmptyProjectAgentsMd,
  getDefaultWorkflowTemplateRoot,
  getInquirer,
  isNestedInOtherGitRepo,
  promptDiscordWebhook,
  providersConfigTemplate,
  roleTemplate,
  setupProject,
};
