const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");

const { detectInstallContext, getUpdateCommand, shouldOfferUpdate } = require("../bin/aio.js");
const { compareVersions, isUpdateCheckDisabled, shouldShowPassiveUpdateNotice } = require("../lib/update");
const { getDevBuildInfo } = require("../lib/build-info");
const { getHelpText, main, parseRunArgs, routeCommand, updatePackage, wantsVersionOnly } = require("../lib/cli");
const {
  chooseTrackingFile,
  configTemplate,
  detectTrackingCandidate,
  INIT_NO_PROVIDER_ERROR,
  providersConfigTemplate,
  setupProject,
} = require("../lib/setup");
const {
  evaluateCondition,
  buildProviderArgs,
  normalizeProviderOutput,
  readConfigFile,
  readProvidersFile,
  runWorkflow,
} = require("../lib/workflow");
const { assistantVisibleText, tryParseStreamJsonLine } = require("../lib/term-sink");
const { readLatestRunId } = require("../lib/observe");
const { mergeEnvFile, readEnvFile } = require("../lib/env-file");
const YAML = require("yaml");

function withProbe(name) {
  return { probeProvider: () => name };
}

function withProbes(names) {
  return { probeProviders: () => names };
}

function skipDiscordInquirer() {
  return {
    select: async () => {
      throw new Error("unexpected select");
    },
    confirm: async () => false,
    input: async () => "",
  };
}

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

test("shouldOfferUpdate only prompts for newer versions on global pnpm installs with a TTY", () => {
  assert.equal(
    shouldOfferUpdate("0.0.2", {
      currentVersion: "0.0.1",
      installContext: "global-pnpm",
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

  assert.deepEqual(getUpdateCommand("global-pnpm"), {
    bin: "pnpm",
    args: ["add", "-g", "@jeansordes/aio@latest"],
    display: "pnpm add -g @jeansordes/aio@latest",
    relaunch: "aio",
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

test("detectInstallContext recognises global pnpm installs from pnpm root -g", () => {
  const sandbox = createSandbox();
  const pnpmGlobal = path.join(sandbox, "pnpm-root-g");
  const packageRoot = createPackage(pnpmGlobal, "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "workspace"),
      scriptPath,
      argv0: "aio",
      env: {},
      pnpmGlobalModulePath: pnpmGlobal,
      npmModulePaths: [path.join(sandbox, "separate-npm")],
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "global-pnpm",
  );
});

test("detectInstallContext recognises global npm from NPM_CONFIG_PREFIX when linked to that tree", () => {
  const sandbox = createSandbox();
  const prefix = path.join(sandbox, "npm-prefix");
  const modulesRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = createPackage(modulesRoot, "@jeansordes", "aio");
  const scriptPath = path.join(packageRoot, "bin", "aio.js");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  assert.equal(
    detectInstallContext({
      cwd: path.join(sandbox, "work"),
      scriptPath,
      argv0: "aio",
      env: { NPM_CONFIG_PREFIX: prefix },
      pnpmGlobalModulePath: null,
      npmModulePaths: [modulesRoot],
      bunGlobalBin: path.join(sandbox, "bun-bin"),
    }),
    "global-npm",
  );
});

test("detectInstallContext is global-npm, not npx, when only npm user agent is set", () => {
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
      argv0: path.join(sandbox, "opt", "bin", "aio"),
      env: { npm_config_user_agent: "npm/10.0.0 node/v22" },
      pnpmGlobalModulePath: null,
      npmModulePaths: [globalRoot],
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

test("detectInstallContext recognises global Bun installs invoked via Bun's symlinked bin shim", () => {
  const sandbox = createSandbox();
  const packageRoot = createPackage(
    path.join(sandbox, "bun-install", "global", "node_modules"),
    "@jeansordes",
    "aio",
  );
  const scriptPath = path.join(packageRoot, "bin", "aio.js");
  const bunGlobalBin = path.join(sandbox, "bun-bin");
  const invocationPath = path.join(bunGlobalBin, "aio");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(bunGlobalBin, { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");
  fs.symlinkSync(scriptPath, invocationPath);

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
    probeProvider: () => "cursor",
    promptForUpdate: async () => {
      prompted = true;
      return false;
    },
  });

  assert.equal(prompted, false);
  assert.equal(fs.existsSync(path.join(sandbox, ".aio", "config.yaml")), true);
  assert.equal(result.scaffoldSpecs, false);
});

test("getDevBuildInfo returns null unless AIO_DEV=1", () => {
  assert.equal(getDevBuildInfo({ env: {} }), null);
  assert.equal(getDevBuildInfo({ env: { AIO_DEV: "0" } }), null);
  const info = getDevBuildInfo({ env: { AIO_DEV: "1" } });
  assert.ok(info && typeof info.dirty === "boolean");
});

test("getHelpText appends dev suffix when devInfo is passed", () => {
  const text = getHelpText({
    devInfo: { commit: "abc1234", dirty: true, committedAt: "2026-04-27T22:00:00.000Z" },
  });
  assert.match(text, /\(dev abc1234, 2026-04-27, dirty\)/);
});

test("wantsVersionOnly recognises version flags as first argument", () => {
  assert.equal(wantsVersionOnly(["version"]), true);
  assert.equal(wantsVersionOnly(["--version"]), true);
  assert.equal(wantsVersionOnly(["-v"]), true);
  assert.equal(wantsVersionOnly(["run", "-v"]), false);
});

test("routeCommand prints version block", async () => {
  const result = await routeCommand(["version"], {
    currentVersion: "1.2.3",
    installContext: "local",
    devInfo: null,
  });
  assert.match(result.version, /@jeansordes\/aio 1\.2\.3/);
  assert.match(result.version, /install: local/);
});

test("routeCommand treats --version like version", async () => {
  const result = await routeCommand(["--version"], {
    currentVersion: "0.0.0",
    installContext: "npx",
    devInfo: null,
  });
  assert.match(result.version, /install: npx/);
});

test("main does not emit passive update when AIO_DEV is set", async () => {
  const noted = [];
  await main({
    argv: ["help"],
    installContext: "unknown",
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    stderrIsTTY: true,
    env: { AIO_DEV: "1" },
    onPassiveUpdateNotice: (message) => {
      noted.push(message);
    },
  });
  assert.equal(noted.length, 0);
});

test("routeCommand prints man-style help for bare aio, help, -h, and --help", async () => {
  const opts = { latestVersion: false };
  const noArgs = (await routeCommand([], opts)).message;
  const help = (await routeCommand(["help"], opts)).message;
  const h = (await routeCommand(["-h"], opts)).message;
  const longHelp = (await routeCommand(["--help"], opts)).message;
  assert.equal(noArgs, help);
  assert.equal(noArgs, h);
  assert.equal(noArgs, longHelp);
  assert.match(noArgs, /NAME/);
  assert.match(noArgs, /SYNOPSIS/);
  assert.match(noArgs, /DESCRIPTION/);
  assert.match(noArgs, /COMMANDS/);
  assert.match(noArgs, /EXAMPLES/);
  assert.match(noArgs, /VERSION/);
  assert.match(noArgs, /aio init/);
  assert.match(noArgs, /aio run/);
  assert.match(noArgs, /aio observe/);
  assert.match(noArgs, /aio update/);
});

test("aio update installs immediately for newer global npm installs", async () => {
  let command = null;

  const result = await main({
    argv: ["update"],
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    installContext: "global-npm",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    promptForUpdate: async () => {
      throw new Error("explicit update should not use the startup prompt");
    },
    installUpdate: (updateCommand) => {
      command = updateCommand;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "updated");
  assert.equal(command.display, "npm install -g @jeansordes/aio@latest");
});

test("aio update reports up-to-date installs without running an installer", () => {
  let installed = false;

  const result = updatePackage({
    latestVersion: "0.2.0",
    currentVersion: "0.2.0",
    installContext: "global-npm",
    installUpdate: () => {
      installed = true;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "up_to_date");
  assert.equal(installed, false);
});

test("aio update does not mutate unsupported install contexts", () => {
  let installed = false;

  const result = updatePackage({
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    installContext: "npx",
    installUpdate: () => {
      installed = true;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "unsupported_install_context");
  assert.equal(installed, false);
});

test("aio update installs immediately for newer global pnpm installs", async () => {
  let command = null;

  const result = await main({
    argv: ["update"],
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    installContext: "global-pnpm",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    promptForUpdate: async () => {
      throw new Error("explicit update should not use the startup prompt");
    },
    installUpdate: (updateCommand) => {
      command = updateCommand;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "updated");
  assert.equal(command.display, "pnpm add -g @jeansordes/aio@latest");
});

test("main emits passive update notice for unknown with newer version when stderr is a TTY", async () => {
  const noted = [];
  await main({
    argv: ["help"],
    installContext: "unknown",
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    stderrIsTTY: true,
    onPassiveUpdateNotice: (message) => {
      noted.push(message);
    },
  });
  assert.equal(noted.length, 1);
  assert.match(noted[0], /9\.9\.9/);
  assert.match(noted[0], /0\.0\.1/);
  assert.match(noted[0], /npm install -g/);
});

test("main does not emit passive update when AIO_NO_UPDATE_CHECK is set", async () => {
  const noted = [];
  await main({
    argv: ["help"],
    installContext: "unknown",
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    stderrIsTTY: true,
    env: { AIO_NO_UPDATE_CHECK: "1" },
    onPassiveUpdateNotice: (message) => {
      noted.push(message);
    },
  });
  assert.equal(noted.length, 0);
});

test("main skips startup update checks when AIO_NO_UPDATE_CHECK is set", async () => {
  let prompted = false;
  const sandbox = createSandbox();
  await main({
    argv: ["init"],
    projectRoot: sandbox,
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    installContext: "global-npm",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { AIO_NO_UPDATE_CHECK: "1" },
    probeProvider: () => "cursor",
    promptForUpdate: async () => {
      prompted = true;
      return true;
    },
  });
  assert.equal(prompted, false);
  assert.equal(fs.existsSync(path.join(sandbox, ".aio", "config.yaml")), true);
});

test("shouldShowPassiveUpdateNotice and isUpdateCheckDisabled", () => {
  assert.equal(
    shouldShowPassiveUpdateNotice("9.0.0", {
      currentVersion: "0.0.1",
      installContext: "unknown",
      stderrIsTTY: true,
      env: {},
    }),
    true,
  );
  assert.equal(
    shouldShowPassiveUpdateNotice("9.0.0", {
      currentVersion: "0.0.1",
      installContext: "unknown",
      stderrIsTTY: true,
      env: { AIO_NO_UPDATE_CHECK: "1" },
    }),
    false,
  );
  assert.equal(isUpdateCheckDisabled({ AIO_NO_UPDATE_CHECK: "true" }), true);
  assert.equal(isUpdateCheckDisabled({}), false);
});

test("init creates the expected .aio structure without non-TTY specs scaffolding", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });

  for (const entry of [
    ".aio/config.yaml",
    ".aio/providers.yaml",
    ".aio/roles/analyse.yaml",
    ".aio/roles/plan.yaml",
    ".aio/roles/build.yaml",
    ".aio/roles/review.yaml",
    ".aio/roles/fix.yaml",
    ".aio/roles/log.yaml",
    ".aio/roles/commit.yaml",
    ".aio/roles/publish.yaml",
    ".aio/roles/summarize.yaml",
    ".aio/workflows/default.yaml",
    ".aio/prompts",
    ".aio/schemas",
    ".aio/.gitignore",
  ]) {
    assert.equal(fs.existsSync(path.join(sandbox, entry)), true, `${entry} should exist`);
  }

  assert.equal(fs.existsSync(path.join(sandbox, "specs")), false);
  const config = YAML.parse(fs.readFileSync(path.join(sandbox, ".aio", "config.yaml"), "utf8"));
  assert.equal(config.tracking.file, null);
  assert.equal(config.defaults.provider, "cursor");
  const analyseRole = fs.readFileSync(path.join(sandbox, ".aio", "roles", "analyse.yaml"), "utf8");
  assert.match(analyseRole, /^provider: cursor\n/m);
});

test("init fails when no provider CLI is detected and does not create .aio", async () => {
  const sandbox = createSandbox();
  await assert.rejects(
    async () => setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, probeProvider: () => null }),
    (err) => err instanceof Error && err.message === INIT_NO_PROVIDER_ERROR,
  );
  assert.equal(fs.existsSync(path.join(sandbox, ".aio")), false);
});

test("main init fails when probe finds no provider", async () => {
  const sandbox = createSandbox();
  await assert.rejects(
    async () =>
      main({
        argv: ["init"],
        projectRoot: sandbox,
        latestVersion: false,
        probeProvider: () => null,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    (err) => err instanceof Error && err.message === INIT_NO_PROVIDER_ERROR,
  );
  assert.equal(fs.existsSync(path.join(sandbox, ".aio")), false);
});

test("non-interactive init writes detected tracking file from specs/roadmap.csv", async () => {
  const sandbox = createSandbox();
  fs.mkdirSync(path.join(sandbox, "specs"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "specs", "roadmap.csv"), "id,title\n");

  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });

  const config = YAML.parse(fs.readFileSync(path.join(sandbox, ".aio", "config.yaml"), "utf8"));
  assert.equal(config.tracking.file, "specs/roadmap.csv");
});

test("non-interactive init prefers first tracking candidate: TASKS.md over ROADMAP.md", async () => {
  const sandbox = createSandbox();
  fs.writeFileSync(path.join(sandbox, "TASKS.md"), "#\n");
  fs.writeFileSync(path.join(sandbox, "ROADMAP.md"), "#\n");

  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });

  const config = YAML.parse(fs.readFileSync(path.join(sandbox, ".aio", "config.yaml"), "utf8"));
  assert.equal(config.tracking.file, "TASKS.md");
});

test("configTemplate encodes tracking file or null", () => {
  assert.match(configTemplate("specs/roadmap.csv"), /tracking:\n  file: specs\/roadmap\.csv/);
  assert.match(configTemplate(null), /tracking:\n  file: null/);
  assert.match(configTemplate(null), /workflow:\n  maxSteps: 100/);
  assert.match(configTemplate(null), /defaults:\n  provider: cursor/);
});

test("providersConfigTemplate configures cursor-agent stream-json and isolation placeholder", () => {
  const config = YAML.parse(providersConfigTemplate());
  assert.equal(config.providers.cursor.command, "cursor-agent");
  assert.deepEqual(config.providers.cursor.args.slice(0, 6), [
    "-p",
    "--force",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ]);
  assert.equal(config.providers.cursor.args.includes("{{isolation_args}}"), true);
  assert.equal(config.providers.cursor.args.includes("{{prompt}}"), true);
  assert.equal(Array.isArray(config.providers.cursor.isolationArgs), true);
  assert.equal(config.providers.custom.status, "not_configured");
});

test("non-interactive init picks first detected provider when several are probed", async () => {
  const sandbox = createSandbox();
  const result = await setupProject({
    projectRoot: sandbox,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    trackingFile: null,
    scaffoldSpecs: false,
    ...withProbes(["codex", "cursor"]),
  });
  assert.equal(result.defaultProvider, "codex");
  const cfg = YAML.parse(fs.readFileSync(path.join(sandbox, ".aio", "config.yaml"), "utf8"));
  assert.equal(cfg.defaults.provider, "codex");
});

test("explicit defaultProvider must be among detected list", async () => {
  const sandbox = createSandbox();
  await assert.rejects(
    async () =>
      setupProject({
        projectRoot: sandbox,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        trackingFile: null,
        scaffoldSpecs: false,
        ...withProbe("cursor"),
        defaultProvider: "claude",
      }),
    (err) => err instanceof Error && err.message.includes("not among detected"),
  );
});

test("interactive init chooses provider via arrow-key select", async () => {
  const sandbox = createSandbox();
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  stdout.isTTY = true;

  const result = await setupProject({
    projectRoot: sandbox,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdin: Readable.from([]),
    stdout,
    trackingFile: null,
    scaffoldSpecs: false,
    ...withProbes(["cursor", "codex"]),
    inquirer: {
      ...skipDiscordInquirer(),
      select: async (opts) => {
        if (String(opts.message).includes("tasks")) return "none";
        return "codex";
      },
    },
  });

  assert.equal(result.defaultProvider, "codex");
  assert.match(chunks.join(""), /Detected provider CLIs/);
});

test("detectTrackingCandidate returns first existing candidate in order", () => {
  const sandbox = createSandbox();
  assert.equal(detectTrackingCandidate(sandbox), null);
  fs.writeFileSync(path.join(sandbox, "ROADMAP.md"), "x");
  assert.equal(detectTrackingCandidate(sandbox), "ROADMAP.md");
  fs.mkdirSync(path.join(sandbox, "specs"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "specs", "roadmap.csv"), "h");
  assert.equal(detectTrackingCandidate(sandbox), "specs/roadmap.csv");
});

test("interactive init with no detection defaults to specs/roadmap.csv and scaffold", async () => {
  const sandbox = createSandbox();
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  stdout.isTTY = true;

  const result = await chooseTrackingFile({
    projectRoot: sandbox,
    stdin: Readable.from([]),
    stdout,
    interactive: true,
    inquirer: {
      select: async () => "scaffold",
    },
  });

  assert.deepEqual(result, { file: "specs/roadmap.csv", scaffoldSpecs: true });
  assert.match(chunks.join(""), /aio init/);
});

test("interactive init keeps detected tracking file without scaffold", async () => {
  const sandbox = createSandbox();
  fs.writeFileSync(path.join(sandbox, "TASKS.md"), "#\n");
  const stdout = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  stdout.isTTY = true;

  const result = await chooseTrackingFile({
    projectRoot: sandbox,
    stdin: Readable.from([]),
    stdout,
    interactive: true,
    inquirer: {
      select: async () => "keep",
    },
  });

  assert.deepEqual(result, { file: "TASKS.md", scaffoldSpecs: false });
});

test("interactive init can disable tracking", async () => {
  const sandbox = createSandbox();
  const stdout = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  stdout.isTTY = true;

  const result = await chooseTrackingFile({
    projectRoot: sandbox,
    stdin: Readable.from([]),
    stdout,
    interactive: true,
    inquirer: {
      select: async () => "none",
    },
  });

  assert.deepEqual(result, { file: null, scaffoldSpecs: false });
});

test("aio run passes projectKnowledge.trackingFile from config to the provider", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  fs.writeFileSync(
    path.join(sandbox, ".aio", "config.yaml"),
    `version: 1
defaultWorkflow: default
providersFile: providers.yaml
rolesDirectory: roles
workflowsDirectory: workflows
workflow:
  maxSteps: 100
tracking:
  file: my-tracker.csv
`,
  );
  writeProvider(
    sandbox,
    "custom",
    'process.stdout.write(prompt);',
  );
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: only
states:
  only:
    role: analyse
    next: done
  done:
    type: final
`,
  );

  const result = await runWorkflow({ projectRoot: sandbox });
  assert.match(result.outputs[0].stdout, /Tracking file: my-tracker\.csv/);
  assert.doesNotMatch(result.outputs[0].stdout, /Previous outputs/);
});

test("setup is idempotent and does not overwrite changed files", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });
  const configPath = path.join(sandbox, ".aio", "config.yaml");
  fs.writeFileSync(configPath, "version: custom\n");

  const result = await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });

  assert.equal(fs.readFileSync(configPath, "utf8"), "version: custom\n");
  assert.equal(result.skipped.includes(configPath), true);
});

test("TTY-style setup can scaffold optional specs files", async () => {
  const sandbox = createSandbox();
  await setupProject({
    projectRoot: sandbox,
    scaffoldSpecs: true,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    ...withProbe("cursor"),
  });

  for (const entry of [
    "specs/roadmap.csv",
    "specs/00-domains",
    "specs/01-features",
    "specs/02-requirements",
  ]) {
    assert.equal(fs.existsSync(path.join(sandbox, entry)), true, `${entry} should exist`);
  }
});

test("aio run executes default.yaml with linear transitions and captured stdout", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(sandbox, "custom", 'process.stdout.write("plain output");');
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

  const result = await runWorkflow({ projectRoot: sandbox });

  assert.equal(result.finalState, "done");
  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["analyse", "plan"],
  );
  assert.equal(result.outputs[0].status, "ok");
  assert.equal(result.outputs[0].stdout, "plain output");
});

test("aio run exposes file changes from the latest provider step", async () => {
  const sandbox = createSandbox();
  require("node:child_process").execFileSync("git", ["init"], { cwd: sandbox, stdio: "ignore" });
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(sandbox, "custom", 'fs.writeFileSync(path.join(process.cwd(), "changed.txt"), "changed\\n");');
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: only
states:
  only:
    role: analyse
    next: done
  done:
    type: final
`,
  );

  const result = await runWorkflow({ projectRoot: sandbox });

  assert.equal(result.outputs[0].has_changes, true);
  assert.deepEqual(result.outputs[0].changed_files, ["changed.txt"]);
});

test("readProvidersFile loads declarative provider configuration", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });

  const providers = readProvidersFile(sandbox, { providersFile: "providers.yaml" });

  assert.equal(providers.providers.cursor.command, "cursor-agent");
  assert.equal(providers.providers.custom.status, "not_configured");
});

test("generated default workflow is runnable with placeholder providers", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("codex") });

  const result = await runWorkflow({ projectRoot: sandbox });

  assert.equal(result.finalState, "done");
  assert.equal(result.steps.review.status, "not_configured");
});

test("aio run custom-name loads a named workflow", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(sandbox, "custom", 'process.stdout.write(prompt);');
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

  const result = await runWorkflow({ projectRoot: sandbox, workflowName: "custom-name" });

  assert.equal(result.workflow, "custom-name");
  assert.match(result.outputs[0].stdout, /Analyse the current project state/);
});

test("conditional transitions route by step state and capture plain text stdout", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(
    sandbox,
    "custom",
    `process.stdout.write("plain text");`,
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
      - if: step.exit_code == 0
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

  const result = await runWorkflow({ projectRoot: sandbox });

  assert.equal(result.outputs[0].stdout, "plain text");
  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["build", "review", "commit"],
  );
});

test("conditional transitions can use git.has_changes in a temp git repo", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
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

  const result = await runWorkflow({ projectRoot: sandbox });

  assert.deepEqual(
    result.outputs.map((output) => output.role),
    ["analyse", "log"],
  );
});

test("compareVersions orders releases above prereleases and ranks prerelease identifiers", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("0.0.1", "0.0.1"), 0);
});

test("readConfigFile rejects unknown keys, bad types, and invalid workflow.maxSteps", () => {
  const sandbox = createSandbox();
  fs.mkdirSync(path.join(sandbox, ".aio"), { recursive: true });
  const configPath = path.join(sandbox, ".aio", "config.yaml");

  fs.writeFileSync(configPath, "extra: true\n");
  assert.throws(
    () => readConfigFile(sandbox),
    (err) => err instanceof Error && err.message.includes('unknown key "extra"'),
  );

  fs.writeFileSync(
    configPath,
    `version: 1
defaultWorkflow: default
providersFile: providers.yaml
rolesDirectory: roles
workflowsDirectory: workflows
tracking:
  file: 99
`,
  );
  assert.throws(
    () => readConfigFile(sandbox),
    (err) => err instanceof Error && err.message.includes("tracking.file") && err.message.includes("string"),
  );

  fs.writeFileSync(
    configPath,
    `version: 1
defaultWorkflow: default
providersFile: providers.yaml
rolesDirectory: roles
workflowsDirectory: workflows
tracking:
  file: null
workflow:
  maxSteps: 0
`,
  );
  assert.throws(
    () => readConfigFile(sandbox),
    (err) => err instanceof Error && err.message.includes("workflow.maxSteps") && err.message.includes("positive"),
  );

  fs.writeFileSync(
    configPath,
    `version: 1
defaultWorkflow: default
providersFile: providers.yaml
rolesDirectory: roles
workflowsDirectory: workflows
defaults:
  provider: 99
tracking:
  file: null
`,
  );
  assert.throws(
    () => readConfigFile(sandbox),
    (err) => err instanceof Error && err.message.includes("defaults.provider") && err.message.includes("string"),
  );
});

test("evaluateCondition warns once when a dot-path in an equality is missing", () => {
  const warnings = [];
  const context = { git: { has_changes: false }, step: { status: "ok" } };
  const pass = (msg) => warnings.push(String(msg));
  const ok = evaluateCondition(`step.status == "ok"`, context, { warn: pass });
  const bad = evaluateCondition(`step.typo == "ok"`, context, { warn: pass });
  assert.equal(ok, true);
  assert.equal(bad, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing path: step\.typo/);
});

test("normalizeProviderOutput warns on invalid JSON and on non-object JSON", () => {
  const warnings = [];
  const pass = (m) => warnings.push(m);
  const notJson = normalizeProviderOutput("not json at all", { warn: pass });
  assert.equal(notJson.status, "ok");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not valid JSON/);
  const arr = normalizeProviderOutput("[1,2,3]", { warn: pass });
  assert.equal(arr.status, "ok");
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /plain object was expected/);
});

test("runWorkflow respects config workflow.maxSteps", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("codex") });
  fs.writeFileSync(
    path.join(sandbox, ".aio", "config.yaml"),
    `version: 1
defaultWorkflow: default
providersFile: providers.yaml
rolesDirectory: roles
workflowsDirectory: workflows
workflow:
  maxSteps: 1
tracking:
  file: null
`,
  );
  await assert.rejects(
    async () => runWorkflow({ projectRoot: sandbox, warn: () => {} }),
    (err) => err instanceof Error && err.message.includes("exceeded 1 steps"),
  );
});

test("parseRunArgs parses flags, workflow, and loop count", () => {
  assert.deepEqual(parseRunArgs(["--quiet", "release"]), {
    quiet: true,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "release",
    loops: 1,
  });
  assert.deepEqual(parseRunArgs(["-q", "default"]), {
    quiet: true,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "default",
    loops: 1,
  });
  assert.deepEqual(parseRunArgs(["3"]), {
    quiet: false,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "default",
    loops: 3,
  });
  assert.deepEqual(parseRunArgs(["release", "5"]), {
    quiet: false,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "release",
    loops: 5,
  });
  assert.deepEqual(parseRunArgs(["--loops", "2", "wf"]), {
    quiet: false,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "wf",
    loops: 2,
  });
  assert.deepEqual(parseRunArgs(["-n", "0"]), {
    quiet: false,
    verbose: false,
    allowEditsOutsideDir: false,
    workflowName: "default",
    loops: 0,
  });
});

test("parseRunArgs rejects conflicting loop specifications", () => {
  assert.throws(
    () => parseRunArgs(["--loops", "3", "5"]),
    (err) => err instanceof Error && err.message.includes("numeric loop count"),
  );
  assert.throws(
    () => parseRunArgs(["a", "b", "c"]),
    (err) => err instanceof Error && err.message.includes("too many positional"),
  );
});

test("buildProviderArgs expands isolationArgs and honors allowEditsOutsideDir", () => {
  const provider = {
    args: ["{{isolation_args}}", "-x", "{{project_root}}"],
    isolationArgs: ["--workspace", "{{project_root}}"],
  };
  assert.deepEqual(
    buildProviderArgs(provider, {
      prompt: "p",
      model: "default",
      projectRoot: "/proj",
      allowEditsOutsideDir: false,
    }),
    ["--workspace", "/proj", "-x", "/proj"],
  );
  assert.deepEqual(
    buildProviderArgs(provider, {
      prompt: "p",
      model: "default",
      projectRoot: "/proj",
      allowEditsOutsideDir: true,
    }),
    ["-x", "/proj"],
  );
});

test("readProvidersFile rejects bad isolationArgs entries", () => {
  const sandbox = createSandbox();
  fs.mkdirSync(path.join(sandbox, ".aio"), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, ".aio", "providers.yaml"),
    `version: 1
providers:
  x:
    command: echo
    args: []
    isolationArgs: [1]
`,
  );
  assert.throws(
    () => readProvidersFile(sandbox),
    (err) => err instanceof Error && err.message.includes("isolationArgs"),
  );
});

test("assistantVisibleText skips duplicate partial assistant events", () => {
  assert.equal(
    assistantVisibleText({
      type: "assistant",
      timestamp_ms: 1,
      model_call_id: "dup",
      message: { content: [{ type: "text", text: "a" }] },
    }),
    null,
  );
  assert.equal(
    assistantVisibleText({
      type: "assistant",
      timestamp_ms: 1,
      message: { content: [{ type: "text", text: "delta" }] },
    }),
    "delta",
  );
});

test("tryParseStreamJsonLine accepts NDJSON objects", () => {
  const ev = tryParseStreamJsonLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
  assert.equal(ev?.type, "assistant");
  assert.equal(tryParseStreamJsonLine("not json"), null);
});

test("init writes empty AGENTS.md when nested in another git repository", async () => {
  const sandbox = createSandbox();
  require("node:child_process").execFileSync("git", ["init"], { cwd: sandbox, stdio: "ignore" });
  const nested = path.join(sandbox, "nested");
  fs.mkdirSync(nested, { recursive: true });
  await setupProject({ projectRoot: nested, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("cursor") });
  assert.equal(fs.existsSync(path.join(nested, "AGENTS.md")), true);
  assert.equal(fs.readFileSync(path.join(nested, "AGENTS.md"), "utf8"), "");
});

test("aio run with loop count creates distinct run directories", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(sandbox, "custom", 'process.stdout.write("x");');
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: only
states:
  only:
    role: analyse
    next: done
  done:
    type: final
`,
  );
  await routeCommand(["run", "2"], { projectRoot: sandbox, latestVersion: false });
  const runsRoot = path.join(sandbox, ".aio", "runs");
  const dirs = fs.readdirSync(runsRoot).filter((n) => n !== "latest");
  assert.equal(dirs.length, 2);
});

test("run writes conversation log and latest pointer", async () => {
  const sandbox = createSandbox();
  await setupProject({ projectRoot: sandbox, stdinIsTTY: false, stdoutIsTTY: false, ...withProbe("custom") });
  writeProvider(sandbox, "custom", 'process.stdout.write("x");');
  writeWorkflow(
    sandbox,
    "default",
    `name: default
initial: only
states:
  only:
    role: analyse
    next: done
  done:
    type: final
`,
  );
  await routeCommand(["run"], { projectRoot: sandbox, latestVersion: false });
  const runId = readLatestRunId(path.join(sandbox, ".aio", "runs"));
  assert.ok(runId);
  const conv = fs.readFileSync(path.join(sandbox, ".aio", "runs", runId, "conversation.log"), "utf8");
  assert.match(conv, /x/);
});

test("mergeEnvFile round-trips webhook secrets", () => {
  const sandbox = createSandbox();
  mergeEnvFile(sandbox, { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/abc" });
  const env = readEnvFile(path.join(sandbox, ".aio", ".env"));
  assert.equal(env.DISCORD_WEBHOOK_URL, "https://discord.com/api/webhooks/abc");
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
  const providerPath = path.join(projectRoot, ".aio", `${provider}-provider.js`);
  fs.writeFileSync(
    providerPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[2] || "";
  ${body}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(projectRoot, ".aio", "providers.yaml"),
    `version: 1
providers:
  ${provider}:
    command: ${JSON.stringify(providerPath)}
    args:
      - "{{prompt}}"
    prompt:
      include:
        - instructions
        - tracking_file
        - context_files
    success:
      exit_codes: [0]
`,
  );
}

function writeWorkflow(projectRoot, name, content) {
  fs.writeFileSync(path.join(projectRoot, ".aio", "workflows", `${name}.yaml`), content);
}
