const { version: CURRENT_VERSION } = require("../package.json");
const { getDevBuildInfo } = require("./build-info");
const { runInteractive } = require("./interactive");
const {
  compareVersions,
  detectInstallContext,
  formatPassiveUpdateMessage,
  formatUnsupportedInstallUpdateMessage,
  getLatestVersion,
  getUpdateCommand,
  installUpdate,
  isUpdateCheckDisabled,
  promptForUpdate,
  shouldOfferUpdate,
  shouldShowPassiveUpdateNotice,
} = require("./update");

const PACKAGE_NAME = "@jeansordes/aio";

/**
 * @param {{ commit: string | null, dirty: boolean, committedAt: string } | null} devInfo
 */
function formatHelpVersionSuffix(devInfo) {
  if (!devInfo) {
    return "";
  }
  const date = devInfo.committedAt ? String(devInfo.committedAt).slice(0, 10) : "";
  const dirtyPart = devInfo.dirty ? ", dirty" : "";
  if (devInfo.commit) {
    const datePart = date ? `, ${date}` : "";
    return ` (dev ${devInfo.commit}${datePart}${dirtyPart})`;
  }
  if (date) {
    return ` (dev built ${date}${dirtyPart})`;
  }
  return "";
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{ commit: string | null, dirty: boolean, committedAt: string } | null | undefined} [options.devInfo] pass null to omit dev suffix
 */
function getHelpText(options = {}) {
  const devInfo =
    options.devInfo !== undefined ? options.devInfo : getDevBuildInfo({ env: options.env ?? process.env });
  const versionSuffix = formatHelpVersionSuffix(devInfo);
  return `AIO(1)                          User commands                          AIO(1)

NAME
     aio - interactive Goals and agent-routed workflows

SYNOPSIS
     aio
     aio help | -h | --help
     aio version | -v | --version
     aio update

DESCRIPTION
     In a terminal, aio offers a standalone Goal, a YAML workflow from
     .aio/workflows/, or a saved session. An ASCII graph shows the active node.
     Goals loop until their criteria are satisfied. Routing agents choose
     among the destinations authorized by the workflow.

     Harness settings live in $XDG_CONFIG_HOME/aio/config.yaml, falling back
     to ~/.config/aio/config.yaml. Sessions and logs stay in the project.
     No arguments without a terminal prints this help.

COMMANDS
     aio
             Open the interactive menu. During execution, p then Enter pauses
             after the current invocation. q then Enter or Ctrl-C stops the
             harness and its tools. Reopen aio to resume the saved checkpoint.

     help, -h, --help
             Print this help.

     version, -v, --version
             Print version and installation details.

     update
             Check for an update and apply it to supported global installs.
             Other installations receive manual update instructions.
             AIO_NO_UPDATE_CHECK=1 disables automatic startup checks.

EXAMPLES
     aio
     aio --help
     aio update

VERSION
     ${PACKAGE_NAME} ${CURRENT_VERSION}${versionSuffix}`;
}

function wantsHelpOnly(argv) {
  const c = argv[0];
  return c == null || c === "help" || c === "-h" || c === "--help";
}

function wantsVersionOnly(argv) {
  const c = argv[0];
  return c === "version" || c === "--version" || c === "-v";
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.currentVersion]
 * @param {ReturnType<typeof detectInstallContext>} [options.installContext]
 * @param {{ commit: string | null, dirty: boolean, committedAt: string } | null} [options.devInfo]
 */
function formatVersionBlock(options = {}) {
  const env = options.env ?? process.env;
  const currentVersion = options.currentVersion ?? CURRENT_VERSION;
  const installContext = options.installContext ?? detectInstallContext({ env });
  const devInfo = options.devInfo !== undefined ? options.devInfo : getDevBuildInfo({ env });
  const lines = [
    `${PACKAGE_NAME} ${currentVersion}`,
    `install: ${installContext}${env.AIO_DEV === "1" ? " (dev)" : ""}`,
  ];
  if (devInfo) {
    const dirty = devInfo.dirty ? " (dirty)" : "";
    lines.push(`commit:  ${devInfo.commit ?? "unknown"}${dirty}`);
    if (devInfo.committedAt) {
      lines.push(`built:   ${devInfo.committedAt}`);
    }
  }
  return lines.join("\n");
}

function isDevMode(env) {
  return env.AIO_DEV === "1";
}

function resolveHelpText(options = {}) {
  const env = options.env ?? process.env;
  return getHelpText({ env });
}

async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const skipStartupUpdate = argv[0] === "update" || wantsVersionOnly(argv);
  if (!skipStartupUpdate) {
    await maybeUpdate(options);
  }
  return routeCommand(argv, options);
}

async function maybeUpdate(options = {}) {
  const env = options.env ?? process.env;
  if (isUpdateCheckDisabled(env)) {
    return;
  }

  const latestVersion = options.latestVersion ?? getLatestVersion();
  const currentVersion = options.currentVersion ?? CURRENT_VERSION;
  const installContext = options.installContext ?? detectInstallContext();

  if (
    shouldOfferUpdate(latestVersion, {
      currentVersion,
      installContext,
      stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY,
      stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY,
    })
  ) {
    const accepted = await (options.promptForUpdate ?? promptForUpdate)(latestVersion, currentVersion);
    if (accepted) {
      const command = getUpdateCommand(installContext);

      if (!command) {
        console.log(resolveHelpText(options));
        return;
      }

      const result = (options.installUpdate ?? installUpdate)(command);

      if (result.status === 0) {
        console.log("");
        console.log(`Updated ${PACKAGE_NAME} to ${latestVersion}.`);
        console.log(`Please relaunch the app with: ${command.relaunch}`);
        process.exit(0);
      }

      console.error("");
      console.error(`Update failed. Please run: ${command.display}`);
      process.exit(result.status ?? 1);
    }
  } else if (
    !isDevMode(env) &&
    shouldShowPassiveUpdateNotice(latestVersion, {
      currentVersion,
      installContext,
      stderrIsTTY: options.stderrIsTTY ?? process.stderr.isTTY,
      env,
    })
  ) {
    const message = formatPassiveUpdateMessage(latestVersion, currentVersion);
    if (options.onPassiveUpdateNotice) {
      options.onPassiveUpdateNotice(message, { installContext });
    } else {
      console.error(message);
    }
  }
}

async function routeCommand(argv, options = {}) {
  if (wantsVersionOnly(argv)) {
    const text = formatVersionBlock(options);
    console.log(text);
    return { version: text };
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  if (argv.length === 0 &&
      (options.stdinIsTTY ?? (options.stdin ?? process.stdin).isTTY) &&
      (options.stdoutIsTTY ?? (options.stdout ?? process.stdout).isTTY)) {
    return runInteractive({ ...options, projectRoot });
  }

  if (wantsHelpOnly(argv)) {
    const message = resolveHelpText(options);
    console.log(message);
    return { message };
  }

  const command = argv[0];

  if (command === "update") {
    return updatePackage(options);
  }

  throw new Error(`Unknown command: ${command}. Run aio to open the menu or aio --help.`);
}

function updatePackage(options = {}) {
  const write = options.write ?? console.log;
  const latestVersion = options.latestVersion ?? getLatestVersion();
  const currentVersion = options.currentVersion ?? CURRENT_VERSION;
  const installContext = options.installContext ?? detectInstallContext();

  if (!latestVersion) {
    throw new Error(`Could not check the latest ${PACKAGE_NAME} version.`);
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    write(`${PACKAGE_NAME} is already up to date (${currentVersion}).`);
    return {
      status: "up_to_date",
      currentVersion,
      latestVersion,
      installContext,
    };
  }

  const updateCommand = getUpdateCommand(installContext);
  if (!updateCommand) {
    write(formatUnsupportedInstallUpdateMessage(installContext, latestVersion));
    return {
      status: "unsupported_install_context",
      currentVersion,
      latestVersion,
      installContext,
    };
  }

  const result = (options.installUpdate ?? installUpdate)(updateCommand);
  if (result.status !== 0) {
    throw new Error(`Update failed. Please run: ${updateCommand.display}`);
  }

  write(`Updated ${PACKAGE_NAME} from ${currentVersion} to ${latestVersion}.`);
  write(`Please relaunch the app with: ${updateCommand.relaunch}`);
  return {
    status: "updated",
    currentVersion,
    latestVersion,
    installContext,
    command: updateCommand,
  };
}

module.exports = {
  formatVersionBlock,
  getHelpText,
  main,
  maybeUpdate,
  resolveHelpText,
  routeCommand,
  updatePackage,
  wantsVersionOnly,
};
