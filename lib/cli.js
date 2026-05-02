const path = require("node:path");
const { version: CURRENT_VERSION } = require("../package.json");
const { getDevBuildInfo } = require("./build-info");
const { normalizeWorkflowName, runWorkflow } = require("./workflow");
const { setupProject } = require("./setup");
const { writeInitDone } = require("./init-ui");
const { createEventBus } = require("./event-bus");
const { startRunLog } = require("./run-log");
const { attachTermSink } = require("./term-sink");
const { attachDiscordSink } = require("./discord-sink");
const { observeRun } = require("./observe");
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
     aio - Jean Sordes's AI Orchestrator, YAML-based agent workflows in a project

SYNOPSIS
     aio
     aio help
     aio -h
     aio --help
     aio version
     aio --version
     aio -v
     aio init
     aio setup
     aio run [ --quiet | -q ] [ --verbose | -v ]
             [ --allow-edits-outside-dir ] [ <workflow> ]
     aio observe [ --events | -e ] [ --run <id> ]
     aio update

DESCRIPTION
     The aio utility scaffolds a project-local .aio/ tree (config, provider
     configuration, role definitions) and runs state machines from YAML under
     .aio/workflows/, delegating each step to an external AI CLI described in
     .aio/providers.yaml.

     With no first argument, or with help, -h, or --help as the first
     argument, aio prints this help. That is the same for bare aio and
     aio help. With version, --version, or -v as the first argument, aio
     prints version and install details. Any other first word (init, setup,
     run, observe, update) runs the corresponding subcommand.

COMMANDS
     help, -h, --help
             Print this help; same as running aio with no arguments.

     version, --version, -v
             Print package version and install context. When AIO_DEV=1 (e.g.
             dev-bin/daio), also print git commit and build timestamp when git
             is available.

     init
     setup
             Create or refresh the .aio/ layout. Existing files are not
             overwritten. setup is a synonym for init.

     run [ flags ] [ <workflow> ]
             Run a workflow once. The default <workflow> name is default, i.e.
             the file .aio/workflows/default.yaml. To repeat work or branch
             back to earlier states, define transitions with next: in the
             workflow YAML; workflow.maxSteps in config caps how many states
             run in one invocation. Each invocation uses one run id and one
             directory under .aio/runs/. First SIGINT finishes the current
             state and ends the run when the workflow returns; a second SIGINT
             aborts the in-flight provider. Live provider output is
             streamed to the terminal; --quiet limits output to milestones;
             --verbose prints raw stream-json lines to stderr when the provider
             emits them. By default the Cursor provider is confined to the
             project directory; --allow-edits-outside-dir disables that
             isolation (a warning is printed). Each run writes
             .aio/runs/<id>/conversation.log and events.jsonl; the latest id
             is stored in .aio/runs/latest.

     observe [ flags ]
             Follow the conversation log for the latest run (like tail -f).
             Use --events to follow events.jsonl instead. Use --run <id> to
             pick a specific run directory under .aio/runs/.

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
     aio observe

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

/**
 * @param {string[]} args argv after "run"
 */
function parseRunArgs(args) {
  let quiet = false;
  let verbose = false;
  let allowEditsOutsideDir = false;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    } else if (a === "--allow-edits-outside-dir") {
      allowEditsOutsideDir = true;
    } else if (a.startsWith("-")) {
      throw new Error(`aio: unknown run flag ${a}`);
    } else {
      positional.push(a);
    }
  }

  let workflowName = "default";

  if (positional.length === 0) {
    workflowName = "default";
  } else if (positional.length === 1) {
    workflowName = positional[0];
  } else {
    throw new Error("aio: too many positional arguments for aio run");
  }

  return { quiet, verbose, allowEditsOutsideDir, workflowName };
}

/**
 * @param {string[]} args argv after "observe"
 */
function parseObserveArgs(args) {
  let events = false;
  /** @type {string | null} */
  let runId = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--events" || a === "-e") {
      events = true;
    } else if (a === "--run") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("aio: --run requires a run id");
      }
      runId = next;
      i += 1;
    } else if (a.startsWith("-")) {
      throw new Error(`aio: unknown observe flag ${a}`);
    }
  }
  return { events, runId };
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

  if (wantsHelpOnly(argv)) {
    const message = resolveHelpText(options);
    console.log(message);
    return { message };
  }

  const command = argv[0];
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
      probeProvider: options.probeProvider,
      probeProviders: options.probeProviders,
      defaultProvider: options.defaultProvider,
      inquirer: options.inquirer,
    });
    if (stdoutIsTTY) {
      writeInitDone(stdout, result, Boolean(stdout.isTTY));
    } else {
      console.log(`Configured aio project at ${result.projectRoot}.`);
    }
    return result;
  }

  if (command === "run") {
    const { quiet, verbose, allowEditsOutsideDir, workflowName } = parseRunArgs(argv.slice(1));
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    if (allowEditsOutsideDir) {
      stderr.write(
        `aio: warning, provider isolation is disabled; the agent may read or write files outside ${path.resolve(projectRoot)}\n`,
      );
    }

    let stopRequested = false;
    /** @type {import('node:events').EventEmitter | null} */
    let currentBus = null;
    const onSigint = () => {
      if (!stopRequested) {
        stopRequested = true;
        stderr.write(
          "\naio: stop requested; finishing current workflow run. Press Ctrl-C again to abort the in-flight provider.\n",
        );
      } else {
        currentBus?.emit("abortRequested");
      }
    };
    process.on("SIGINT", onSigint);

    /** @type {Awaited<ReturnType<typeof runWorkflow>> | null} */
    let lastResult = null;

    try {
      const bus = createEventBus();
      currentBus = bus;
      const { close: closeRunLog, runId, runDir } = startRunLog(projectRoot, {
        bus,
        workflowLabel: normalizeWorkflowName(workflowName),
      });
      const detachTerm = attachTermSink(bus, {
        quiet,
        verbose,
        stdout,
        stderr,
      });
      const detachDiscord = attachDiscordSink(bus, {
        projectRoot,
        env: options.env ?? process.env,
      });
      try {
        lastResult = await runWorkflow({
          projectRoot,
          workflowName,
          maxSteps: options.maxSteps,
          bus,
          runId,
          runDir,
          allowEditsOutsideDir,
        });
        stdout.write(`Workflow ${lastResult.workflow} completed at ${lastResult.finalState}.\n`);
      } finally {
        detachTerm();
        detachDiscord();
        closeRunLog();
      }
    } finally {
      process.off("SIGINT", onSigint);
      currentBus = null;
    }

    return lastResult;
  }

  if (command === "observe") {
    const obs = parseObserveArgs(argv.slice(1));
    await observeRun(projectRoot, {
      runId: obs.runId ?? undefined,
      events: obs.events,
      stdout: options.stdout ?? process.stdout,
    });
    return { observed: true };
  }

  if (command === "update") {
    return updatePackage(options);
  }

  const message = resolveHelpText(options);
  console.log(message);
  return { message };
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
  formatVersionBlock,
  getHelpText,
  main,
  maybeUpdate,
  parseObserveArgs,
  parseRunArgs,
  resolveHelpText,
  routeCommand,
  updatePackage,
  wantsVersionOnly,
};
