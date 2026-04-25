const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectInstallContext, getUpdateCommand, shouldOfferUpdate } = require("../bin/aio.js");

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
