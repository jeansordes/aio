const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectInstallContext, getUpdateCommand, shouldOfferUpdate } = require("../bin/aio.js");
const { main, routeCommand } = require("../lib/cli");
const { setupProject } = require("../lib/setup");
const { runWorkflow } = require("../lib/workflow");

test("shouldOfferUpdate only prompts for newer versions on global npm installs with a TTY", () => {
  assert.equal(
    shouldOfferUpdate("0.0.2", {
      currentVersion: "0.0.1",
      installContext: "global-npm",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    true,
  );
});

test("shouldOfferUpdate only prompts for newer versions on global Bun installs with a TTY", () => {
  assert.equal(
    shouldOfferUpdate("0.0.2", {
      currentVersion: "0.0.1",
      installContext: "global-bun",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    true,
  );
});

test("shouldOfferUpdate suppresses prompts for npx, bunx, and local executions", () => {
  for (const installContext of ["npx", "bunx", "local", "unknown"]) {
    assert.equal(
      shouldOfferUpdate("0.0.2", {
        currentVersion: "0.0.1",
        installContext,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
      false,
    );
  }
});

test("shouldOfferUpdate suppresses prompts when version is not newer or no TTY is available", () => {
  assert.equal(
    shouldOfferUpdate("0.0.1", {
      currentVersion: "0.0.1",
      installContext: "global-npm",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    false,
  );

  assert.equal(
    shouldOfferUpdate("0.0.2", {
      currentVersion: "0.0.1",
      installContext: "global-npm",
      stdinIsTTY: false,
      stdoutIsTTY: true,
    }),
    false,
  );
});

test("getUpdateCommand maps global npm and Bun installs to the correct installer", () => {
  assert.deepEqual(getUpdateCommand("global-npm"), {
    bin: "npm",
    args: ["install", "-g", "@jeansordes/aio@latest"],
    display: "npm install -g @jeansordes/aio@latest",
    relaunch: "npx @jeansordes/aio",
  });

  assert.deepEqual(getUpdateCommand("global-bun"), {
    bin: "bun",
    args: ["add", "-g", "@jeansordes/aio@latest"],
    display: "bun add -g @jeansordes/aio@latest",
    relaunch: "bunx @jeansordes/aio",
  });
});

test("detectInstallContext recognises local development runs inside the current project", () => {
  const sandbox = createSandbox();
  const packageRoot = createPackage(sandbox, "repo");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");
  const subdirectory = path.join(packageRoot, "src");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(subdirectory, { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: subdirectory,
      scriptPath,
      argv0: "node",
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "local",
  );
});

test("detectInstallContext recognises local project installs under node_modules", () => {
  const sandbox = createSandbox();
  const workspace = path.join(sandbox, "workspace");
  const packageRoot = createPackage(path.join(workspace, "node_modules"), "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: workspace,
      scriptPath,
      argv0: "node",
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "local",
  );
});

test("detectInstallContext recognises global npm installs from npm root -g", () => {
  const sandbox = createSandbox();
  const globalRoot = path.join(sandbox, "global-npm");
  const packageRoot = createPackage(globalRoot, "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      argv0: "aio",
      env: {},
      npmGlobalRoot: globalRoot,
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "global-npm",
  );
});

test("detectInstallContext recognises global Bun installs from Bun's global bin path", () => {
  const sandbox = createSandbox();
  const packageRoot = createPackage(path.join(sandbox, "bun-install"), "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");
  const bunGlobalBin = path.join(sandbox, "bun-bin");
  const invocationPath = path.join(bunGlobalBin, "aio");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(bunGlobalBin, { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");
  fs.writeFileSync(invocationPath, "#!/usr/bin/env bash\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      invocationPath,
      argv0: invocationPath,
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin,
    }),
    "global-bun",
  );
});

test("detectInstallContext recognises npx and bunx invocations", () => {
  const sandbox = createSandbox();
  const packageRoot = createPackage(path.join(sandbox, "cache"), "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      argv0: "npx",
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "npx",
  );

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      argv0: "bunx",
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "bunx",
  );
});

test("detectInstallContext fails closed when Bun global path detection is unavailable", () => {
  const sandbox = createSandbox();
  const packageRoot = createPackage(path.join(sandbox, "bun-install"), "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");
  const invocationPath = path.join(sandbox, "not-global", "aio");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(invocationPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");
  fs.writeFileSync(invocationPath, "#!/usr/bin/env bash\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      invocationPath,
      argv0: invocationPath,
      env: {},
      npmGlobalRoot: path.join(sandbox, "global-npm"),
      bunGlobalBin: null,
    }),
    "unknown",
  );
});

test("main routes commands after update gating without prompting in non-TTY runs", async () => {
  const sandbox = createSandbox();
  let prompted = false;

  const result = await main({
    argv: ["init"],
    projectRoot: sandbox,
    latestVersion: "9.9.9",
    installContext: "global-npm",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    promptForUpdate: async () => {
      prompted = true;
      return false;
    },
  });

  assert.equal(prompted, false);
  assert.equal(fs.existsSync(path.join(sandbox, ".aio", "config.yaml")), true);
  assert.equal(result.scaffoldSpecs, false);
});

test("routeCommand keeps the no-command placeholder behavior", async () => {
  const result = await routeCommand([], { latestVersion: false });
  assert.match(result.message, /currently under construction/);
});

test("init creates the expected .aio structure without non-TTY specs scaffolding", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });

  for (const entry of [
    ".aio/config.yaml",
    ".aio/providers/cursor.sh",
    ".aio/providers/codex.sh",
    ".aio/providers/claude.sh",
    ".aio/providers/gemini.sh",
    ".aio/providers/opencode.sh",
    ".aio/providers/custom.sh",
    ".aio/roles/analyse.yaml",
    ".aio/roles/plan.yaml",
    ".aio/roles/build.yaml",
    ".aio/roles/review.yaml",
    ".aio/roles/fix.yaml",
    ".aio/roles/log.yaml",
    ".aio/roles/commit.yaml",
    ".aio/roles/publish.yaml",
    ".aio/workflows/default.yaml",
    ".aio/prompts",
    ".aio/schemas",
  ]) {
    assert.equal(fs.existsSync(path.join(sandbox, entry)), true, `${entry} should exist`);
  }

  assert.equal(fs.existsSync(path.join(sandbox, "specs")), false);
});

test("setup is idempotent and does not overwrite changed files", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });
  const configPath = path.join(sandbox, ".aio", "config.yaml");
  fs.writeFileSync(configPath, "version: custom\n");

  const result = await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });

  assert.equal(fs.readFileSync(configPath, "utf8"), "version: custom\n");
  assert.equal(result.skipped.includes(configPath), true);
});

test("TTY-style setup can scaffold optional specs files", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, scaffoldSpecs: true });

  for (const entry of [
    "specs/roadmap.csv",
    "specs/00-domains",
    "specs/01-features",
    "specs/02-requirements",
  ]) {
    assert.equal(fs.existsSync(path.join(sandbox, entry)), true, `${entry} should exist`);
  }
});

test("aio run executes default.yaml with linear transitions and parsed JSON output", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });
  writeProvider(sandbox, "custom", 'process.stdout.write(JSON.stringify({ status: "ok", role: request.role }));');
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: one
states:
  one:
    role: analyse
    next: two
  two:
    role: plan
    next: done
  done:
    type: final
`,
  );

  const result = runWorkflow({ projectRoot: sandbox });

  assert.equal(result.finalState, "done");
  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["analyse", "plan"],
  );
  assert.equal(result.previousOutputs.analyse.status, "ok");
});

test("generated default workflow is runnable with placeholder providers", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });

  const result = runWorkflow({ projectRoot: sandbox });

  assert.equal(result.finalState, "done");
  assert.equal(result.previousOutputs.review.status, "not_configured");
});

test("aio run custom-name loads a named workflow", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });
  writeProvider(sandbox, "custom", 'process.stdout.write(JSON.stringify({ status: "ok", workflow: request.workflow }));');
  writeWorkflow(
    sandbox,
    "custom-name",
    `name: custom-name
initial: only
states:
  only:
    role: analyse
    next: done
  done:
    type: final
`,
  );

  const result = runWorkflow({ projectRoot: sandbox, workflowName: "custom-name" });

  assert.equal(result.workflow, "custom-name");
  assert.equal(result.previousOutputs.analyse.workflow, "custom-name");
});

test("conditional transitions route by provider output and capture plain text stdout", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });
  writeProvider(
    sandbox,
    "custom",
    `if (request.role === "review") {
  process.stdout.write(JSON.stringify({ status: "approved" }));
} else {
  process.stdout.write("plain text");
}`,
  );
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: build
states:
  build:
    role: build
    next: review
  review:
    role: review
    next:
      - if: review.status == "approved"
        then: commit
      - then: fix
  fix:
    role: fix
    next: done
  commit:
    role: commit
    next: done
  done:
    type: final
`,
  );

  const result = runWorkflow({ projectRoot: sandbox });

  assert.equal(result.outputs[0].output.content, "plain text");
  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["build", "review", "commit"],
  );
});

test("conditional transitions can use git.has_changes in a temp git repo", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false });
  fs.writeFileSync(path.join(sandbox, "changed.txt"), "changed\n");
  require("node:child_process").execFileSync("git", ["init"], { cwd: sandbox, stdio: "ignore" });
  writeProvider(sandbox, "custom", 'process.stdout.write(JSON.stringify({ status: "ok" }));');
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: inspect
states:
  inspect:
    role: analyse
    next:
      - if: git.has_changes == true
        then: log
      - then: done
  log:
    role: log
    next: done
  done:
    type: final
`,
  );

  const result = runWorkflow({ projectRoot: sandbox });

  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["analyse", "log"],
  );
});

function createSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aio-test-"));
}

function createPackage(...segments) {
  const packageRoot = path.join(...segments);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@jeansordes/aio", version: "0.0.1" }),
  );
  return packageRoot;
}

function writeProvider(projectRoot, provider, body) {
  const providerPath = path.join(projectRoot, ".aio", "providers", `${provider}.sh`);
  fs.writeFileSync(
    providerPath,
    `#!/usr/bin/env sh
node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  ${body}
});
'
`,
    { mode: 0o755 },
  );
}

function writeWorkflow(projectRoot, name, content) {
  fs.writeFileSync(path.join(projectRoot, ".aio", "workflows", `${name}.yaml`), content);
}
