const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");

const PROVIDERS = ["cursor", "codex", "claude", "gemini", "opencode", "custom"];
const ROLES = ["analyse", "plan", "build", "review", "fix", "log", "commit", "publish"];
const TRACKING_CANDIDATES = ["specs/roadmap.csv", "TASKS.md", "ROADMAP.md"];

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

  const created = [];
  const skipped = [];

  ensureDirectory(path.join(projectRoot, ".aio"), created);
  for (const directory of ["providers", "roles", "workflows", "prompts", "schemas"]) {
    ensureDirectory(path.join(projectRoot, ".aio", directory), created);
  }

  writeFileIfMissing(path.join(projectRoot, ".aio", "config.yaml"), configTemplate(trackingFile), created, skipped);

  for (const provider of PROVIDERS) {
    const providerPath = path.join(projectRoot, ".aio", "providers", `${provider}.sh`);
    writeFileIfMissing(providerPath, providerTemplate(provider), created, skipped, { mode: 0o755 });
  }

  for (const role of ROLES) {
    writeFileIfMissing(path.join(projectRoot, ".aio", "roles", `${role}.yaml`), roleTemplate(role), created, skipped);
  }

  writeFileIfMissing(path.join(projectRoot, ".aio", "workflows", "default.yaml"), defaultWorkflowTemplate(), created, skipped);

  if (scaffoldSpecs) {
    scaffoldSpecsStructure(projectRoot, created, skipped);
  }

  return { projectRoot, created, skipped, scaffoldSpecs, trackingFile: trackingFile ?? null };
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

  const cli = createInterface({ input: stdin, output: stdout });
  try {
    const promptText = detected
      ? `Tracking file for tasks/specs/roadmap [${detected}] (enter to accept, a path, 's' to scaffold specs/roadmap.csv, 'n' for none): `
      : `Tracking file for tasks/specs/roadmap (type a path, 's' to scaffold specs/roadmap.csv, 'n' for none): `;
    const answer = await new Promise((resolve) => cli.question(promptText, resolve));
    const trimmed = answer.trim();

    if (trimmed === "") {
      return { file: detected, scaffoldSpecs: false };
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
  const trackingValue = trackingFile ? trackingFile : "null";
  return `version: 1
defaultWorkflow: default
providersDirectory: providers
rolesDirectory: roles
workflowsDirectory: workflows
tracking:
  file: ${trackingValue}
`;
}

function providerTemplate(provider) {
  if (provider === "cursor") {
    return cursorProviderTemplate();
  }
  return placeholderProviderTemplate(provider);
}

function placeholderProviderTemplate(provider) {
  return `#!/usr/bin/env sh
node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = input ? JSON.parse(input) : {};
  process.stdout.write(JSON.stringify({
    status: "not_configured",
    content: "Provider ${provider} is not configured. Edit .aio/providers/${provider}.sh to call your AI CLI.",
    provider: request.provider || "${provider}"
  }));
});
'
`;
}

function cursorProviderTemplate() {
  return `#!/usr/bin/env sh
# Requires: cursor-agent on PATH (https://cursor.com/cli) and CURSOR_API_KEY in the environment.
node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const req = input ? JSON.parse(input) : {};
  const sections = [];
  if (req.instructions) sections.push(req.instructions);
  if (req.projectKnowledge && req.projectKnowledge.trackingFile) {
    sections.push("Tracking file: " + req.projectKnowledge.trackingFile);
  }
  if (req.contextFiles && req.contextFiles.length) {
    sections.push("Context files:\\n" + req.contextFiles.join("\\n"));
  }
  if (req.previousOutputs && Object.keys(req.previousOutputs).length) {
    sections.push("Previous outputs:\\n" + JSON.stringify(req.previousOutputs, null, 2));
  }
  const prompt = sections.filter(Boolean).join("\\n\\n");
  const args = ["-p", "--force", "--trust", "--output-format", "json"];
  if (req.model && req.model !== "default") {
    args.push("--model", req.model);
  }
  args.push(prompt);
  const result = require("child_process").spawnSync("cursor-agent", args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) {
    process.stdout.write(JSON.stringify({ status: "error", content: result.error.message, provider: "cursor" }));
    return;
  }
  if (result.stdout && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
    return;
  }
  process.stdout.write(JSON.stringify({ status: "error", content: "cursor-agent produced no output", provider: "cursor" }));
});
'
`;
}

function roleTemplate(role) {
  const instructions = {
    analyse: "Analyse the current project state and summarize the work needed.",
    plan: "Create a concise implementation plan from the analysis.",
    build: "Implement the planned change in the working tree.",
    review: "Review the implementation and return status approved when it is ready.",
    fix: "Address review feedback or test failures.",
    log: "Record a concise summary of the current workflow result.",
    commit: "Prepare or create the commit requested by the workflow.",
    publish: "Publish or hand off the completed change as configured by the project.",
  };

  return `provider: custom
model: default
instructions: ${JSON.stringify(instructions[role])}
contextFiles: []
`;
}

function defaultWorkflowTemplate() {
  return `name: default
initial: analyse
states:
  analyse:
    role: analyse
    next: plan
  plan:
    role: plan
    next: build
  build:
    role: build
    next: review
  review:
    role: review
    next:
      - if: review.status == "approved"
        then: commit
      - if: review.status == "not_configured"
        then: log
      - if: git.has_changes == true
        then: fix
      - then: log
  fix:
    role: fix
    next: review
  log:
    role: log
    next: done
  commit:
    role: commit
    next: publish
  publish:
    role: publish
    next: done
  done:
    type: final
`;
}

module.exports = {
  PROVIDERS,
  ROLES,
  TRACKING_CANDIDATES,
  chooseTrackingFile,
  configTemplate,
  cursorProviderTemplate,
  defaultWorkflowTemplate,
  detectTrackingCandidate,
  placeholderProviderTemplate,
  providerTemplate,
  setupProject,
};
