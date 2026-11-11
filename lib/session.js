const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateWorkflow } = require("./graph");
const { check } = require("./harnesses");

function atomicJson(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function openSession(root) {
  const base = path.join(root, ".aio", "sessions");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(base, ".gitignore"), "*\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const lock = path.join(base, "lock");
  try { fs.writeFileSync(lock, process.pid + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Session locked. If aio and its harness have stopped, remove ${lock} and reopen aio.`);
  }
  const dir = path.join(base, "current");
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (error) { fs.unlinkSync(lock); throw error; }
  const file = path.join(dir, "session.json");
  return {
    dir, file,
    load() {
      let state;
      try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      check(state.version === 1, "Unsupported session format. Start from a new session directory.");
      validateWorkflow(state.workflow);
      check(Object.hasOwn(state.workflow.nodes, state.current) && Array.isArray(state.history) &&
        Array.isArray(state.guidance), "Invalid saved session.");
      if (state.inFlight) {
        Object.assign(state, { status: "paused", inFlight: false, interrupted: true,
          reason: "The last invocation was interrupted and may have changed project files." });
        atomicJson(file, state);
      }
      return state;
    },
    start(workflow, defaults) {
      validateWorkflow(workflow);
      const state = { version: 1, workflow: structuredClone(workflow), defaults: { ...defaults },
        current: workflow.initial, visit: 1, turns: 0, status: "paused", history: [],
        results: {}, guidance: [], summary: "", inFlight: false, interrupted: false, reason: null };
      // Commit the replacement before clearing the auxiliary log.
      atomicJson(file, state);
      fs.writeFileSync(path.join(dir, "events.jsonl"), "", { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "conversation.log"), "", { mode: 0o600 });
      return state;
    },
    save(state) { atomicJson(file, state); },
    attach(bus) {
      const bindings = [];
      for (const event of ["nodeEnter", "checkpoint", "transition", "paused", "completed", "notification",
        "providerStart", "providerStdout", "providerStderr", "providerExit"]) {
        const listener = (payload) => {
          const row = { time: new Date().toISOString(), type: event, ...payload };
          fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
          if (event === "providerStdout" || event === "providerStderr") {
            fs.appendFileSync(path.join(dir, "conversation.log"), payload.chunk, { mode: 0o600 });
          }
        };
        bus.on(event, listener);
        bindings.push([event, listener]);
      }
      return () => { for (const [event, listener] of bindings) bus.off(event, listener); };
    },
    close() { fs.unlinkSync(lock); },
  };
}

module.exports = { openSession };
