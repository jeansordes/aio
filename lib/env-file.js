const fs = require("node:fs");
const path = require("node:path");

/**
 * Minimal KEY=value reader for .env (no interpolation).
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} projectRoot
 * @returns {Record<string, string>}
 */
function loadProjectEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".aio", ".env");
  return readEnvFile(envPath);
}

/**
 * Merge entries into .aio/.env (create file + parent dirs). Does not remove existing unrelated keys.
 * @param {string} projectRoot
 * @param {Record<string, string>} entries
 */
function mergeEnvFile(projectRoot, entries) {
  const aioDir = path.join(projectRoot, ".aio");
  const envPath = path.join(aioDir, ".env");
  const existing = readEnvFile(envPath);
  const merged = { ...existing, ...entries };
  const lines = Object.keys(merged)
    .sort()
    .map((k) => `${k}=${quoteEnvValue(merged[k])}`);
  fs.mkdirSync(aioDir, { recursive: true });
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function quoteEnvValue(value) {
  const s = String(value ?? "");
  if (/[\s#"']/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

module.exports = {
  loadProjectEnv,
  mergeEnvFile,
  readEnvFile,
  quoteEnvValue,
};
