const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");

const PROVIDERS = ["cursor", "codex", "claude", "gemini", "opencode", "custom"];
const ROLES = ["analyse", "plan", "build", "review", "fix", "log", "commit", "publish"];

async function setupProject(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const scaffoldSpecs =
    options.scaffoldSpecs ??
    (await shouldScaffoldSpecs({
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY,
      stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY,
    }));

  const created = [];
  const skipped = [];

  ensureDirectory(path.join(projectRoot, ".aio"), created);
  for (const directory of ["providers", "roles", "workflows", "prompts", "schemas"]) {
    ensureDirectory(path.join(projectRoot, ".aio", directory), created);
  }

  writeFileIfMissing(path.join(projectRoot, ".aio", "config.yaml"), configTemplate(), created, skipped);

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

  return { projectRoot, created, skipped, scaffoldSpecs };
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

function shouldScaffoldSpecs({ stdin, stdout, stdinIsTTY, stdoutIsTTY }) {
  if (!stdinIsTTY || !stdoutIsTTY) {
    return false;
  }

  return new Promise((resolve) => {
    const cli = createInterface({ input: stdin, output: stdout });
    cli.question("Scaffold this repo's optional specs/ roadmap structure? (y/n) ", (answer) => {
      cli.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
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

function configTemplate() {
  return `version: 1
defaultWorkflow: default
providersDirectory: providers
rolesDirectory: roles
workflowsDirectory: workflows
`;
}

function providerTemplate(provider) {
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
  defaultWorkflowTemplate,
  setupProject,
};
