const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configPath, loadHarnesses, saveDefault, resolveHarness, harnessArgs } = require("../lib/harnesses");

test("global harness settings are reused with node overrides and literal prompt arguments", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "settings") };
  const loaded = loadHarnesses(env);
  loaded.config.harnesses = {
    fixture: { command: process.execPath, args: ["{{model_args}}", "{{prompt}}"],
      modelArgs: ["--model", "{{model}}"] },
  };
  saveDefault(loaded, "fixture");
  const again = loadHarnesses(env);
  assert.equal(again.config.defaultHarness, "fixture");
  const selected = resolveHarness({ model: "node-model" }, { harness: "fixture", model: "global-model" }, again, env);
  assert.deepEqual(harnessArgs(selected, { prompt: "$& {{model}}", projectRoot: "/project" }),
    ["--model", "node-model", "$& {{model}}"]);
  assert.equal(configPath({ HOME: dir, XDG_CONFIG_HOME: "relative" }), path.join(dir, ".config/aio/config.yaml"));
  assert.equal(loadHarnesses({ HOME: dir }).config.defaultHarness, undefined);
});

test("bad global configuration fails rather than falling back to an arbitrary harness", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir };
  fs.mkdirSync(path.join(dir, "aio"));
  fs.writeFileSync(configPath(env), "harnesses:\n  custom:\n    command: test\n    args: []\n");
  assert.throws(() => loadHarnesses(env), /accept the prompt/);
});
