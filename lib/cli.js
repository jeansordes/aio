const { version: CURRENT_VERSION } = require("../package.json");
const { runWorkflow } = require("./workflow");
const { setupProject } = require("./setup");
const {
  compareVersions,
  detectInstallContext,
  getLatestVersion,
  getUpdateCommand,
  installUpdate,
  promptForUpdate,
  shouldOfferUpdate,
} = require("./update");

const PACKAGE_NAME = "@jeansordes/aio";
const MESSAGE =
  "Hi! Welcome to Jean Sordes's AI Orchestrator, a tool for orchestrating AI agents in coding project. The project is currently under construction, stay tuned !";

async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv[0] !== "update") {
    await maybeUpdate(options);
  }
  return routeCommand(argv, options);
}

async function maybeUpdate(options = {}) {
  const latestVersion = options.latestVersion ?? getLatestVersion();
  const installContext = options.installContext ?? detectInstallContext();

  if (
    shouldOfferUpdate(latestVersion, {
      currentVersion: CURRENT_VERSION,
      installContext,
      stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY,
      stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY,
    })
  ) {
    const accepted = await (options.promptForUpdate ?? promptForUpdate)(latestVersion, CURRENT_VERSION);
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
  }
}

async function routeCommand(argv, options = {}) {
  const [command, argument] = argv;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (command === "init" || command === "setup") {
    const result = await setupProject({
      projectRoot,
      scaffoldSpecs: options.scaffoldSpecs,
      stdin: options.stdin,
      stdout: options.stdout,
      stdinIsTTY: options.stdinIsTTY,
      stdoutIsTTY: options.stdoutIsTTY,
    });
    console.log(`Configured aio project at ${result.projectRoot}.`);
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
    console.log(`${PACKAGE_NAME} ${latestVersion} is available.`);
    console.log(`This ${installContext} invocation cannot update a persistent install automatically.`);
    console.log(`Install it with: npm install -g ${PACKAGE_NAME}@latest`);
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
  main,
  maybeUpdate,
  routeCommand,
  updatePackage,
};
