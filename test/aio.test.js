const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectInstallContext, getUpdateCommand, shouldOfferUpdate } = require("../bin/aio.js");
const { compareVersions, isUpdateCheckDisabled, shouldShowPassiveUpdateNotice } = require("../lib/update");
const { getDevBuildInfo } = require("../lib/build-info");
const { getHelpText, main, routeCommand, updatePackage, wantsVersionOnly } = require("../lib/cli");

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
    argv: ["help"],
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
  assert.equal(fs.existsSync(path.join(sandbox, ".aio")), false);
  assert.match(result.message, /SYNOPSIS/);
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

test("non-interactive bare aio prints the same man-style help as explicit help flags", async () => {
  const opts = { stdinIsTTY: true, stdoutIsTTY: true };
  const noArgs = (await routeCommand([], { ...opts, stdoutIsTTY: false })).message;
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
  assert.match(noArgs, /Goals/);
  assert.doesNotMatch(noArgs, /aio (init|setup|run|observe)/);
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
    argv: ["help"],
    projectRoot: sandbox,
    latestVersion: "9.9.9",
    currentVersion: "0.0.1",
    installContext: "global-npm",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { AIO_NO_UPDATE_CHECK: "1" },
    promptForUpdate: async () => {
      prompted = true;
      return true;
    },
  });
  assert.equal(prompted, false);
  assert.equal(fs.existsSync(path.join(sandbox, ".aio")), false);
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

test("compareVersions orders releases above prereleases and ranks prerelease identifiers", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("0.0.1", "0.0.1"), 0);
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


test("retired commands fail clearly without modifying the project", async (t) => {
  const dir = createSandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const command of ["init", "setup", "run", "observe"]) {
    await assert.rejects(routeCommand([command], { projectRoot: dir }), /Unknown command/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
