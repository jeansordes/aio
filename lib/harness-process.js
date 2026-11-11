const { spawn, spawnSync } = require("node:child_process");
const { harnessArgs } = require("./harnesses");
const { safeText } = require("./text");
const WINDOWS = process.platform === "win32";

function runHarness({ harness, root, env, prompt, signal, bus, nodeId, rawArgs, timeoutMs }) {
  const args = rawArgs ?? harnessArgs(harness, { prompt, projectRoot: root });
  const timeout = new AbortController();
  signal = AbortSignal.any([signal, timeout.signal]);
  const timer = timeoutMs ? setTimeout(() => timeout.abort(), timeoutMs) : null;
  const captured = { stdout: "", stderr: "" };
  let stdoutOverflow = false;
  const meta = { stateName: nodeId, roleName: "agent", phase: "main" };
  // A separate process group lets aio stop tools spawned by the harness as well.
  const child = spawn(harness.command, args, {
    cwd: root,
    env: { ...env, GIT_CEILING_DIRECTORIES: root },
    detached: !WINDOWS,
    stdio: [harness.promptInput === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const started = Date.now();
  bus.emit("providerStart", { ...meta, providerCommand: harness.command });
  return new Promise((resolve) => {
    let error;
    let killTimer;
    function killGroup(force) {
      if (!child.pid) return;
      if (WINDOWS) {
        const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true, timeout: 3000,
        });
        if (result.status !== 0) child.kill();
      } else {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch (e) {
          if (e.code !== "ESRCH") error ??= e;
        }
      }
    }
    function abort() {
      killGroup(false);
      if (!WINDOWS) killTimer = setTimeout(() => killGroup(true), 1500);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, event] of [[child.stdout, "providerStdout"], [child.stderr, "providerStderr"]]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const kind = event === "providerStdout" ? "stdout" : "stderr";
        captured[kind] += chunk;
        if (captured[kind].length > 65536) {
          if (kind === "stdout") stdoutOverflow = true;
          captured[kind] = captured[kind].slice(-65536);
        }
        bus.emit(event, { ...meta, chunk: safeText(chunk) });
      });
      stream.on("end", () => bus.emit(event, { ...meta, chunk: "\n" }));
    }
    if (child.stdin) {
      child.stdin.on("error", (e) => { if (e.code !== "EPIPE") error ??= e; });
      child.stdin.end(prompt);
    }
    child.on("error", (e) => { error = e; });
    // A descendant might still hold the harness pipes open after the leader exits.
    child.on("exit", () => { if (!WINDOWS) killGroup(true); });
    child.on("close", (code, termSignal) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      const status = signal.aborted ? "interrupted" :
        (!error && (harness.successExitCodes ?? [0]).includes(code) ? "ok" : "failed");
      bus.emit("providerExit", { ...meta, status, exit_code: code, durationMs: Date.now() - started });
      clearTimeout(timer);
      resolve({ code, termSignal, error, ...captured, stdoutOverflow, timedOut: timeout.signal.aborted });
    });
  });
}

module.exports = { runHarness };
