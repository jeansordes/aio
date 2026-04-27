const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");

const PACKAGE_NAME = "@jeansordes/aio";
const { version: CURRENT_VERSION } = require("../package.json");

function getLatestVersion() {
  try {
    return execFileSync("npm", ["view", PACKAGE_NAME, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function shouldOfferUpdate(latestVersion, options = {}) {
  const {
    currentVersion = CURRENT_VERSION,
    installContext = detectInstallContext(),
    stdinIsTTY = process.stdin.isTTY,
    stdoutIsTTY = process.stdout.isTTY,
  } = options;

  if (!latestVersion) {
    return false;
  }

  if (!stdinIsTTY || !stdoutIsTTY) {
    return false;
  }

  if (
    installContext !== "global-npm" &&
    installContext !== "global-bun" &&
    installContext !== "global-pnpm"
  ) {
    return false;
  }

  return compareVersions(latestVersion, currentVersion) > 0;
}

const SEMVER_CORE_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1|0|1}
 */
function compareVersions(left, right) {
  const a = parseSemverCore(String(left).trim());
  const b = parseSemverCore(String(right).trim());
  if (a && b) {
    if (a.major !== b.major) {
      return a.major < b.major ? -1 : 1;
    }
    if (a.minor !== b.minor) {
      return a.minor < b.minor ? -1 : 1;
    }
    if (a.patch !== b.patch) {
      return a.patch < b.patch ? -1 : 1;
    }
    if (a.prerelease === null && b.prerelease === null) {
      return 0;
    }
    if (a.prerelease === null) {
      return 1;
    }
    if (b.prerelease === null) {
      return -1;
    }
    return comparePrerelease(a.prerelease, b.prerelease);
  }
  return String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
}

/**
 * @param {string} value
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | null } | null}
 */
function parseSemverCore(value) {
  const m = value.match(SEMVER_CORE_RE);
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] != null && m[4] !== "" ? m[4] : null,
  };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function comparePrerelease(a, b) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= aParts.length) {
      return -1;
    }
    if (i >= bParts.length) {
      return 1;
    }
    const ac = aParts[i];
    const bc = bParts[i];
    const aNum = isNumericIdentifier(ac);
    const bNum = isNumericIdentifier(bc);
    if (aNum && bNum) {
      const an = Number(ac);
      const bn = Number(bc);
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      if (ac !== bc) {
        return ac < bc ? -1 : 1;
      }
    }
  }
  return 0;
}

/**
 * @param {string} id
 */
function isNumericIdentifier(id) {
  return id !== "" && !/[^0-9]/.test(id);
}

function promptForUpdate(latestVersion, currentVersion) {
  return new Promise((resolve) => {
    const cli = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    cli.question(
      `A newer version of ${PACKAGE_NAME} is available (${currentVersion} -> ${latestVersion}). Update now? (y/n) `,
      (answer) => {
        cli.close();
        resolve(answer.trim().toLowerCase() === "y");
      },
    );
  });
}

function installUpdate(command) {
  return spawnSync(command.bin, command.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function getUpdateCommand(installContext = detectInstallContext()) {
  if (installContext === "global-bun") {
    return {
      bin: "bun",
      args: ["add", "-g", `${PACKAGE_NAME}@latest`],
      display: `bun add -g ${PACKAGE_NAME}@latest`,
      relaunch: `bunx ${PACKAGE_NAME}`,
    };
  }

  if (installContext === "global-pnpm") {
    return {
      bin: "pnpm",
      args: ["add", "-g", `${PACKAGE_NAME}@latest`],
      display: `pnpm add -g ${PACKAGE_NAME}@latest`,
      relaunch: "aio",
    };
  }

  if (installContext === "global-npm") {
    return {
      bin: "npm",
      args: ["install", "-g", `${PACKAGE_NAME}@latest`],
      display: `npm install -g ${PACKAGE_NAME}@latest`,
      relaunch: `npx ${PACKAGE_NAME}`,
    };
  }

  return null;
}

function detectInstallContext(options = {}) {
  const cwd = resolvePathOrNull(options.cwd ?? process.cwd());
  const scriptPath = resolvePathOrNull(options.scriptPath ?? require.main?.filename ?? __filename);
  const packageRoot = resolvePackageRoot(scriptPath);
  const argv = options.argv ?? process.argv;
  const argv0 = options.argv0 ?? process.argv0;
  const env = options.env ?? process.env;
  const npmModulePaths = collectNpmGlobalModulePaths(options, env);
  const pnpmGlobalPath =
    options.pnpmGlobalModulePath !== undefined
      ? options.pnpmGlobalModulePath
        ? normalizeDirectoryPath(options.pnpmGlobalModulePath)
        : null
      : getPnpmGlobalModulePath();
  const bunGlobalBin = normalizeDirectoryPath(options.bunGlobalBin ?? getBunGlobalBin());
  const invocationPathArgs = {
    argv,
    argv0,
    env,
    execPath: options.execPath ?? process.execPath,
    invocationPath: options.invocationPath,
  };
  const invocationPath = resolveInvocationPath(invocationPathArgs);
  const lexicalInvocationPath = resolveLexicalInvocationPath(invocationPathArgs);

  if (isLocalExecution({ cwd, packageRoot, scriptPath })) {
    return "local";
  }

  if (isNpxExecution({ argv0, env })) {
    return "npx";
  }

  if (isBunxExecution({ argv0, env, invocationPath })) {
    return "bunx";
  }

  if (packageRoot && pnpmGlobalPath && isSubpath(packageRoot, pnpmGlobalPath)) {
    return "global-pnpm";
  }

  if (
    packageRoot &&
    npmModulePaths.some((root) => root && isSubpath(packageRoot, root))
  ) {
    return "global-npm";
  }

  if (
    bunGlobalBin &&
    ((invocationPath && isSubpath(invocationPath, bunGlobalBin)) ||
      (lexicalInvocationPath && isSubpath(lexicalInvocationPath, bunGlobalBin)))
  ) {
    return "global-bun";
  }

  if (bunGlobalBin && packageRoot && bunBinShimResolvesIntoPackage(bunGlobalBin, packageRoot)) {
    return "global-bun";
  }

  return "unknown";
}

function isLocalExecution({ cwd, packageRoot, scriptPath }) {
  if (!cwd) {
    return false;
  }

  const projectRoots = getAncestorDirectories(cwd);

  return projectRoots.some((projectRoot) => {
    const nodeModulesPath = path.join(projectRoot, "node_modules");
    return (
      isSameOrNested(cwd, packageRoot) ||
      isSameOrNested(packageRoot, nodeModulesPath) ||
      isSameOrNested(scriptPath, nodeModulesPath)
    );
  });
}

function isNpxExecution({ argv0, env }) {
  if (basenameMatches(argv0, "npx")) {
    return true;
  }
  if (String(env.NPX_CWD ?? "") !== "") {
    return true;
  }
  return false;
}

function isBunxExecution({ argv0, env, invocationPath }) {
  const userAgent = String(env.npm_config_user_agent ?? "").toLowerCase();
  return basenameMatches(argv0, "bunx") || basenameMatches(env._, "bunx") || basenameMatches(invocationPath, "bunx") || userAgent.startsWith("bun/");
}

function resolveInvocationPath({ argv, argv0, env, execPath, invocationPath }) {
  const candidates = [invocationPath, argv0, env._, argv?.[1], execPath];

  for (const candidate of candidates) {
    const resolved = resolvePathOrNull(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveLexicalInvocationPath({ argv, argv0, env, execPath, invocationPath }) {
  const candidates = [invocationPath, argv0, env._, argv?.[1], execPath];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    return path.resolve(String(candidate));
  }

  return null;
}

function bunBinShimResolvesIntoPackage(bunGlobalBin, packageRoot) {
  const shimPath = path.join(bunGlobalBin, "aio");
  let resolvedShim;
  try {
    resolvedShim = fs.realpathSync.native(shimPath);
  } catch {
    return false;
  }

  return isSameOrNested(resolvedShim, packageRoot);
}

function resolvePackageRoot(scriptPath) {
  let current = scriptPath;

  while (current) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const next = path.dirname(current);
    if (next === current) {
      return null;
    }

    current = next;
  }

  return null;
}

function getNpmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function collectNpmGlobalModulePaths(options, env) {
  if (Array.isArray(options.npmModulePaths)) {
    return options.npmModulePaths.map((p) => normalizeDirectoryPath(p)).filter(Boolean);
  }

  const fromOption = options.npmGlobalRoot
    ? normalizeDirectoryPath(options.npmGlobalRoot)
    : normalizeDirectoryPath(getNpmGlobalRoot());
  const fromPrefix = getNpmGlobalModulePathFromNpmConfigPrefix(env);
  return [...new Set([fromOption, fromPrefix].filter(Boolean))];
}

function getNpmGlobalModulePathFromNpmConfigPrefix(env) {
  const raw = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
  if (!raw) {
    return null;
  }

  return normalizeDirectoryPath(path.join(String(raw), "lib", "node_modules"));
}

function getPnpmGlobalModulePath() {
  try {
    return normalizeDirectoryPath(
      execFileSync("pnpm", ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim(),
    );
  } catch {
    return null;
  }
}

function getBunGlobalBin() {
  try {
    return execFileSync("bun", ["pm", "bin", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function getAncestorDirectories(inputPath) {
  const directories = [];
  let current = inputPath;

  while (current) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

function isSameOrNested(targetPath, parentPath) {
  return Boolean(targetPath && parentPath && (targetPath === parentPath || isSubpath(targetPath, parentPath)));
}

function isSubpath(targetPath, parentPath) {
  if (!targetPath || !parentPath) {
    return false;
  }

  const relativePath = path.relative(parentPath, targetPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function resolvePathOrNull(inputPath) {
  if (!inputPath) {
    return null;
  }

  const candidate = path.resolve(String(inputPath));

  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

function normalizeDirectoryPath(inputPath) {
  const resolved = resolvePathOrNull(inputPath);
  return resolved ? path.resolve(resolved) : null;
}

function basenameMatches(inputPath, expected) {
  if (!inputPath) {
    return false;
  }

  return path.basename(String(inputPath)).toLowerCase() === expected.toLowerCase();
}

const PASSIVE_UPDATE_CONTEXTS = new Set(["unknown", "npx", "bunx"]);

function isUpdateCheckDisabled(env = process.env) {
  const v = String(env.AIO_NO_UPDATE_CHECK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function shouldShowPassiveUpdateNotice(latestVersion, options = {}) {
  const {
    currentVersion = CURRENT_VERSION,
    installContext = detectInstallContext(),
    stderrIsTTY = process.stderr.isTTY,
    env = process.env,
  } = options;

  if (!latestVersion) {
    return false;
  }

  if (isUpdateCheckDisabled(env)) {
    return false;
  }

  if (!stderrIsTTY) {
    return false;
  }

  if (!PASSIVE_UPDATE_CONTEXTS.has(installContext)) {
    return false;
  }

  return compareVersions(latestVersion, currentVersion) > 0;
}

function formatManualInstallHintLines() {
  return [
    `npm install -g ${PACKAGE_NAME}@latest`,
    `pnpm add -g ${PACKAGE_NAME}@latest`,
    `bun add -g ${PACKAGE_NAME}@latest`,
  ];
}

function formatPassiveUpdateMessage(latestVersion, currentVersion) {
  return (
    `${PACKAGE_NAME}: a newer version ${latestVersion} is available (you are on ${currentVersion}). ` +
    `To update, run one of: ${formatManualInstallHintLines().join("  |  ")}`
  );
}

function formatUnsupportedInstallUpdateMessage(installContext, latestVersion) {
  const lead =
    installContext === "unknown"
      ? "The install type could not be determined as a standard global npm, pnpm, or Bun copy, " +
        "so aio will not run an installer for you automatically."
      : `The ${installContext} invocation does not self-update.`;

  return [
    `${PACKAGE_NAME} ${latestVersion} is available.`,
    lead,
    "Update using one of:",
    ...formatManualInstallHintLines().map((line) => `  ${line}`),
  ].join("\n");
}

module.exports = {
  compareVersions,
  detectInstallContext,
  formatManualInstallHintLines,
  formatPassiveUpdateMessage,
  formatUnsupportedInstallUpdateMessage,
  getLatestVersion,
  getUpdateCommand,
  installUpdate,
  isUpdateCheckDisabled,
  promptForUpdate,
  shouldOfferUpdate,
  shouldShowPassiveUpdateNotice,
};
