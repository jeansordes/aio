const { createStyle } = require("./init-ui");

/**
 * @param {object} ev
 * @returns {string | null} text to stream, or null if this assistant event should be ignored
 */
function assistantVisibleText(ev) {
  if (ev.type !== "assistant") {
    return null;
  }
  const parts = ev.message?.content;
  if (!Array.isArray(parts)) {
    return null;
  }
  const texts = parts.filter((p) => p && p.type === "text" && p.text).map((p) => p.text);
  const t = texts.join("");
  if (!t) {
    return null;
  }
  if (ev.timestamp_ms != null && ev.model_call_id != null) {
    return null;
  }
  return t;
}

/**
 * @param {object} ev
 * @returns {string | null}
 */
function toolCallSummaryLine(ev) {
  if (ev.type !== "tool_call") {
    return null;
  }
  const subtype = ev.subtype ?? "?";
  const tc = ev.tool_call;
  let name = "tool";
  if (tc && typeof tc === "object") {
    if (tc.readToolCall) name = `read_file`;
    else if (tc.writeToolCall) name = `write_file`;
    else if (tc.function?.name) name = String(tc.function.name);
    else {
      const keys = Object.keys(tc);
      if (keys.length) name = keys[0];
    }
  }
  return `${subtype} ${name}`;
}

/**
 * @param {string} line
 * @returns {object | null} parsed event, or null if not JSON object
 */
function tryParseStreamJsonLine(line) {
  try {
    const ev = JSON.parse(line);
    if (ev && typeof ev === "object" && !Array.isArray(ev)) {
      return ev;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * @param {import('node:events').EventEmitter} bus
 * @param {{ quiet?: boolean, verbose?: boolean, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream }} options
 * @returns {() => void} detach
 */
function attachTermSink(bus, options = {}) {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const useColor = Boolean(stdout.isTTY);
  const s = createStyle(useColor);

  const prefix = (stateName, roleName, phase) =>
    s.dim(`[${stateName}/${roleName}${phase && phase !== "main" ? `/${phase}` : ""}]`);

  const HEARTBEAT_BASE_MS = 4000;
  const HEARTBEAT_CAP_MS = 60_000;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let heartbeatTimer = null;
  let heartbeatIntervalMs = HEARTBEAT_BASE_MS;
  let heartbeatStartedAt = 0;
  let lastProviderChunkAt = 0;
  /** @type {{ stateName: string, roleName: string, phase: string } | null} */
  let heartbeatCtx = null;

  /** @type {string} */
  let stdoutNdjsonBuf = "";
  /** @type {string} */
  let stderrNdjsonBuf = "";
  let assistantLineOpen = false;

  function clearProviderHeartbeat() {
    if (heartbeatTimer != null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatCtx = null;
    heartbeatIntervalMs = HEARTBEAT_BASE_MS;
  }

  function bumpProviderOutputActivity() {
    lastProviderChunkAt = Date.now();
    heartbeatIntervalMs = HEARTBEAT_BASE_MS;
  }

  function scheduleHeartbeatTick() {
    if (heartbeatTimer != null) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(heartbeatTick, heartbeatIntervalMs);
  }

  function heartbeatTick() {
    heartbeatTimer = null;
    if (!heartbeatCtx) return;
    if (Date.now() - lastProviderChunkAt < heartbeatIntervalMs - 250) {
      scheduleHeartbeatTick();
      return;
    }
    const { stateName, roleName, phase } = heartbeatCtx;
    const elapsedSec = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
    stdout.write(`${prefix(stateName, roleName, phase)} ${s.dim(`still running… ${elapsedSec}s elapsed\n`)}`);
    heartbeatIntervalMs = Math.min(heartbeatIntervalMs * 2, HEARTBEAT_CAP_MS);
    scheduleHeartbeatTick();
  }

  /**
   * @param {{ stateName: string, roleName: string, phase: string }} ctx
   */
  function startProviderHeartbeat(ctx) {
    clearProviderHeartbeat();
    if (!stdout.isTTY) {
      return;
    }
    heartbeatCtx = ctx;
    heartbeatStartedAt = Date.now();
    lastProviderChunkAt = Date.now();
    heartbeatIntervalMs = HEARTBEAT_BASE_MS;
    scheduleHeartbeatTick();
  }

  /**
   * @param {{ stateName: string, roleName: string, phase: string, chunk?: string }} p
   * @param {"stdout" | "stderr"} streamKind
   */
  function handleProviderChunk(p, streamKind) {
    bumpProviderOutputActivity();
    if (!p.chunk) return;

    const quietOnlyVerbose = quiet && verbose;

    let buf = streamKind === "stdout" ? stdoutNdjsonBuf : stderrNdjsonBuf;
    buf += String(p.chunk);
    const lines = buf.split(/\r?\n/);
    const incomplete = lines.pop() ?? "";
    if (streamKind === "stdout") {
      stdoutNdjsonBuf = incomplete;
    } else {
      stderrNdjsonBuf = incomplete;
    }

    for (const line of lines) {
      if (line.length === 0) continue;
      if (verbose) {
        stderr.write(`${line}\n`);
      }

      if (quietOnlyVerbose) continue;
      if (quiet) continue;

      const ev = tryParseStreamJsonLine(line);
      if (!ev) {
        if (assistantLineOpen) {
          stdout.write("\n");
          assistantLineOpen = false;
        }
        stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${line}\n`);
        continue;
      }

      const aText = assistantVisibleText(ev);
      if (aText != null) {
        if (!assistantLineOpen) {
          stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} `);
          assistantLineOpen = true;
        }
        stdout.write(aText);
        continue;
      }

      const toolLine = toolCallSummaryLine(ev);
      if (toolLine != null) {
        if (assistantLineOpen) {
          stdout.write("\n");
          assistantLineOpen = false;
        }
        stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${s.dim(toolLine)}\n`);
        continue;
      }

      if (assistantLineOpen) {
        stdout.write("\n");
        assistantLineOpen = false;
      }
      stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${line}\n`);
    }
  }

  const bindings = [
    [
      "loopStart",
      (p) => {
        const total = p.total == null ? "∞" : String(p.total);
        stdout.write(`\n${s.dim(`══ loop ${p.iteration}/${total} ══`)}\n`);
      },
    ],
    [
      "loopEnd",
      () => {
        stdout.write("\n");
      },
    ],
    [
      "stateEnter",
      (p) => {
        stdout.write(`\n${s.bold("→")} ${s.cyan(p.stateName)} ${s.dim("role")} ${p.roleName} ${s.dim("provider")} ${p.providerName}\n`);
      },
    ],
    [
      "providerStart",
      (p) => {
        stdoutNdjsonBuf = "";
        stderrNdjsonBuf = "";
        assistantLineOpen = false;
        stdout.write(`${s.dim("⋯")} ${p.phase} ${s.dim(String(p.providerCommand))}\n`);
        if (!quiet) {
          startProviderHeartbeat({
            stateName: p.stateName,
            roleName: p.roleName,
            phase: p.phase,
          });
        }
      },
    ],
    ...(quiet && !verbose
      ? []
      : [
          ["providerStdout", (p) => handleProviderChunk(p, "stdout")],
          ["providerStderr", (p) => handleProviderChunk(p, "stderr")],
        ]),
    [
      "providerExit",
      (p) => {
        clearProviderHeartbeat();
        if (assistantLineOpen) {
          stdout.write("\n");
          assistantLineOpen = false;
        }
        const ok = p.status === "ok";
        const mark = ok ? s.green("✓") : s.yellow("✗");
        stdout.write(
          `${mark} ${p.phase} ${s.dim(`${p.status}`)} ${s.dim(`exit ${p.exit_code ?? "?"}`)} ${s.dim(`${p.durationMs}ms`)}\n`,
        );
      },
    ],
    [
      "transition",
      (p) => {
        stdout.write(`${s.dim("↪")} ${p.from} ${s.dim("→")} ${p.to}\n`);
      },
    ],
    [
      "runError",
      (p) => {
        clearProviderHeartbeat();
        if (assistantLineOpen) {
          stdout.write("\n");
          assistantLineOpen = false;
        }
        stdout.write(`${s.yellow("error:")} ${p.message}\n`);
      },
    ],
  ];

  for (const [ev, fn] of bindings) {
    bus.on(ev, fn);
  }

  return () => {
    clearProviderHeartbeat();
    for (const [ev, fn] of bindings) {
      bus.off(ev, fn);
    }
  };
}

module.exports = {
  attachTermSink,
  assistantVisibleText,
  tryParseStreamJsonLine,
  toolCallSummaryLine,
};
