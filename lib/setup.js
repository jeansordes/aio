const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const { createStyle, writeInitIntro } = require("./init-ui");

const PROVIDERS = ["cursor", "codex", "claude", "gemini", "opencode", "custom"];
const ROLES = ["analyse", "plan", "build", "review", "fix", "log", "commit", "publish"];
const TRACKING_CANDIDATES = ["specs/roadmap.csv", "TASKS.md", "ROADMAP.md"];

const DEFAULT_WORKFLOW_RELATIVE = path.join("templates", "default-workflow");

/** Declarative providers aio can select at init after a successful version probe. */
const PROVIDER_PROBE_CATALOG = [{ name: "cursor", command: "cursor-agent", args: ["--version"] }];

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
function renderConfigOnly(filePath, trackingFileYaml) {
  let body = fs.readFileSync(filePath, "utf8");
  body = body.replaceAll("__AIO_TRACKING_FILE__", trackingFileYaml);
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
      content = renderConfigOnly(src, trackingFileYaml);
    } else {
      content = renderTemplateFile(src, defaultProvider);
    }
    writeFileIfMissing(dest, content, created, skipped);
  }
}

/**
 * @param {object} [options]
 * @param {() => string | null} [options.probeProvider] — override for tests; return a provider name from the template (e.g. cursor) or null
 * @returns {string | null}
 */
function detectInstalledProvider(options = {}) {
  if (typeof options.probeProvider === "function") {
    return options.probeProvider();
  }
  for (const entry of PROVIDER_PROBE_CATALOG) {
    const result = spawnSync(entry.command, entry.args, {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return entry.name;
    }
  }
  return null;
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
    });
    if (trackingFile === undefined) trackingFile = choice.file;
    if (scaffoldSpecs === undefined) scaffoldSpecs = choice.scaffoldSpecs;
  }

  if (scaffoldSpecs && !trackingFile) {
    trackingFile = "specs/roadmap.csv";
  }

  const defaultProvider = detectInstalledProvider(options);
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

  if (scaffoldSpecs) {
    scaffoldSpecsStructure(projectRoot, created, skipped);
  }

  return { projectRoot, created, skipped, scaffoldSpecs, trackingFile: trackingFile ?? null, defaultProvider };
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

async function chooseTrackingFile({ projectRoot, stdin, stdout, interactive }) {
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

  const cli = createInterface({ input: stdin, output: stdout });
  try {
    const promptText = `${style.bold("›")} ${style.dim(
      detected ? "[Enter] confirm detected file  ·  s  ·  n  ·  path" : "[Enter] recommended default  ·  s  ·  n  ·  path",
    )} `;
    const answer = await new Promise((resolve) => cli.question(promptText, resolve));
    const trimmed = answer.trim();

    if (trimmed === "") {
      if (detected) {
        return { file: detected, scaffoldSpecs: false };
      }
      return { file: "specs/roadmap.csv", scaffoldSpecs: true };
    }
    if (trimmed.toLowerCase() === "n") {
      return { file: null, scaffoldSpecs: false };
    }
    if (trimmed.toLowerCase() === "s") {
      return { file: "specs/roadmap.csv", scaffoldSpecs: true };
    }
    return { file: trimmed, scaffoldSpecs: false };
  } finally {
    cli.close();
  }
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

function configTemplate(trackingFile) {
  const configPath = path.join(getDefaultWorkflowTemplateRoot(), "config.yaml");
  const trackingFileYaml = formatTrackingFileYaml(trackingFile);
  return renderConfigOnly(configPath, trackingFileYaml);
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
  chooseTrackingFile,
  configTemplate,
  defaultWorkflowTemplate,
  detectInstalledProvider,
  detectTrackingCandidate,
  getDefaultWorkflowTemplateRoot,
  providersConfigTemplate,
  roleTemplate,
  setupProject,
};
