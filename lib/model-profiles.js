const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { randomUUID } = require('node:crypto');
const { configPath, keys, check, nonempty, resolveHarness } = require('./harnesses');

const validName = (name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
function validateProfiles(data) {
  keys(data, ['profiles'], 'model profiles');
  keys(data.profiles, Object.keys(data.profiles ?? {}), 'profiles');
  for (const [name, entries] of Object.entries(data.profiles)) {
    check(validName(name), `Invalid profile name: ${name}`);
    check(Array.isArray(entries) && entries.length > 0, `Profile ${name} needs at least one model.`);
    for (const entry of entries) {
      keys(entry, ['harness', 'model'], `model in ${name}`);
      check(nonempty(entry.harness) && nonempty(entry.model), `Profile ${name} needs a harness and model for every entry.`);
    }
  }
  return data;
}
function loadProfiles(env = process.env) {
  const file = path.join(path.dirname(configPath(env)), 'model-profiles.yaml');
  let data = { profiles: {} };
  try { data = YAML.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { file, ...validateProfiles(data) };
}
function saveProfiles(loaded) {
  const data = validateProfiles({ profiles: loaded.profiles });
  fs.mkdirSync(path.dirname(loaded.file), { recursive: true, mode: 0o700 });
  const tmp = loaded.file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, YAML.stringify(data), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, loaded.file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function snapshotProfiles(workflow, profiles, loaded) {
  const selected = {};
  const harnesses = {};
  for (const node of Object.values(workflow.nodes)) {
    if (!['action', 'route'].includes(node.type)) continue;
    const name = node.modelProfile;
    check(Object.hasOwn(profiles, name), `Missing model profile: ${name}. Configure it in Settings.`);
    validateProfiles({ profiles: { [name]: profiles[name] } });
    selected[name] = structuredClone(profiles[name]);
    for (const entry of profiles[name]) {
      check(Object.hasOwn(loaded.harnesses, entry.harness), `Unknown harness: ${entry.harness}`);
      const harness = loaded.harnesses[entry.harness];
      check(harness.args.includes('{{model_args}}') && harness.modelArgs?.some(v => v.includes('{{model}}')) ||
        harness.args.some(v => v.includes('{{model}}')), `Harness ${entry.harness} cannot select a model.`);
      harnesses[entry.harness] = structuredClone(harness);
    }
  }
  return { profiles: selected, harnesses };
}
function resolveEntry(entry, snapshot, env) {
  return resolveHarness(entry, {}, { harnesses: snapshot.harnesses, file: 'session model profiles' }, env);
}
// Only diagnostic failures, never the agent's ordinary prose, trigger a reattempt.
function fallbackReason(text) {
  if (/\b(insufficient_quota|quota_exceeded|usage_limit_reached)\b|quota (?:is )?(?:exceeded|exhausted)|(?:usage|credit|spending) limit (?:has been )?(?:reached|exceeded)|out of (?:credits|quota)/i.test(text)) return 'quota exhausted';
  if (/\brate_limit(?:_exceeded|_error)?\b|too many requests|rate limit(?:ed| exceeded| reached)/i.test(text)) return 'rate limited';
  if (/\bmodel_not_found\b|(?:unknown|unavailable|unsupported) model|model[^\n]{0,100}(?:not found|not available|not supported|does not exist)/i.test(text)) return 'model unavailable';
  return null;
}
module.exports = { validName, validateProfiles, loadProfiles, saveProfiles, snapshotProfiles, resolveEntry, fallbackReason };
