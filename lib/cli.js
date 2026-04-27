const { version: CURRENT_VERSION } = require("../package.json");
const { runWorkflow } = require("./workflow");
const { setupProject } = require("./setup");
const { writeInitDone } = require("./init-ui");
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

function getHelpText() {
  return `AIO(1)                          User commands                          AIO(1)

NAME
     aio - Jean Sordes's AI Orchestrator, YAML-based agent workflows in a project

SYNOPSIS
     aio
     aio help
     aio -h
     aio --help
     aio init
     aio setup
     aio run [ <workflow> ]
     aio update

DESCRIPTION
     The aio utility scaffolds a project-local .aio/ tree (config, provider
     wrappers, role definitions) and runs state machines from YAML under
     .aio/workflows/, delegating each step to a script in .aio/providers/.

     With no first argument, or with help, -h, or --help as the first
     argument, aio prints this help. That is the same for bare aio and
     aio help. Any other first word (init, setup, run, update) runs the
     corresponding subcommand.

COMMANDS
     help, -h, --help
             Print this help; same as running aio with no arguments.

     init
     setup
             Create or refresh the .aio/ layout. Existing files are not
             overwritten. setup is a synonym for init.

     run [ <workflow> ]
             Run a workflow. The default <workflow> name is default, i.e. the
             file .aio/workflows/default.yaml. With a name, the file is
             .aio/workflows/<workflow>.yaml.

     update
             Fetches the latest version from the registry. For installs aio can
             identify as a global npm, pnpm, or Bun copy, it may run that
             package manager to upgrade. npx, bunx, local, and unknown installs
             print install commands instead of mutating an unrelated
             environment. On startup, when an update exists but self-update
             is not available, a one-line notice may be printed to stderr; set
             AIO_NO_UPDATE_CHECK=1 to skip registry checks and notices.

EXAMPLES
     aio init
     aio run
     aio run release

VERSION
     ${PACKAGE_NAME} ${CURRENT_VERSION}`;
}

function wantsHelpOnly(argv) {
  const c = argv[0];
  return c == null || c === "help" || c === "-h" || c === "--help";
}

const MESSAGE = getHelpText();

async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv[0] !== "update") {
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
        console.log(MESSAGE);
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
  if (wantsHelpOnly(argv)) {
    console.log(MESSAGE);
    return { message: MESSAGE };
  }

  const [command, argument] = argv;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (command === "init" || command === "setup") {
    const stdout = options.stdout ?? process.stdout;
    const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;
    const result = await setupProject({
      projectRoot,
      scaffoldSpecs: options.scaffoldSpecs,
      stdin: options.stdin,
      stdout,
      stdinIsTTY: options.stdinIsTTY,
      stdoutIsTTY: options.stdoutIsTTY,
    });
    if (stdoutIsTTY) {
      writeInitDone(stdout, result, Boolean(stdout.isTTY));
    } else {
      console.log(`Configured aio project at ${result.projectRoot}.`);
    }
    return result;
  }

  if (command === "run") {
    const result = runWorkflow({
      projectRoot,
      workflowName: argument ?? "default",
      maxSteps: options.maxSteps,
    });
    console.log(`Workflow ${result.workflow} completed at ${result.finalState}.`);
    return result;
  }

  if (command === "update") {
    return updatePackage(options);
  }

  console.log(MESSAGE);
  return { message: MESSAGE };
}

function updatePackage(options = {}) {
  const latestVersion = options.latestVersion ?? getLatestVersion();
  const currentVersion = options.currentVersion ?? CURRENT_VERSION;
  const installContext = options.installContext ?? detectInstallContext();

  if (!latestVersion) {
    throw new Error(`Could not check the latest ${PACKAGE_NAME} version.`);
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    console.log(`${PACKAGE_NAME} is already up to date (${currentVersion}).`);
    return {
      status: "up_to_date",
      currentVersion,
      latestVersion,
      installContext,
    };
  }

  const updateCommand = getUpdateCommand(installContext);
  if (!updateCommand) {
    console.log(formatUnsupportedInstallUpdateMessage(installContext, latestVersion));
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

  console.log(`Updated ${PACKAGE_NAME} from ${currentVersion} to ${latestVersion}.`);
  console.log(`Please relaunch the app with: ${updateCommand.relaunch}`);
  return {
    status: "updated",
    currentVersion,
    latestVersion,
    installContext,
    command: updateCommand,
  };
}

module.exports = {
  MESSAGE,
  getHelpText,
  main,
  maybeUpdate,
  routeCommand,
  updatePackage,
};
