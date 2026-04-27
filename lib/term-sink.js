const { createStyle } = require("./init-ui");

/**
 * @param {import('node:events').EventEmitter} bus
 * @param {{ quiet?: boolean, verbose?: boolean, stdout?: NodeJS.WriteStream }} options
 * @returns {() => void} detach
 */
function attachTermSink(bus, options = {}) {
  const quiet = Boolean(options.quiet);
  const stdout = options.stdout ?? process.stdout;
  const useColor = Boolean(stdout.isTTY);
  const s = createStyle(useColor);

  const prefix = (stateName, roleName, phase) =>
    s.dim(`[${stateName}/${roleName}${phase && phase !== "main" ? `/${phase}` : ""}]`);

  const HEARTBEAT_MS = 4000;
  /** @type {ReturnType<typeof setInterval> | null} */
  let heartbeatTimer = null;
  let lastProviderChunkAt = 0;
  /** @type {{ stateName: string, roleName: string, phase: string } | null} */
  let heartbeatCtx = null;

  function clearProviderHeartbeat() {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatCtx = null;
  }

  function bumpProviderOutputActivity() {
    lastProviderChunkAt = Date.now();
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
    lastProviderChunkAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!heartbeatCtx) return;
      if (Date.now() - lastProviderChunkAt < HEARTBEAT_MS - 250) return;
      const { stateName, roleName, phase } = heartbeatCtx;
      stdout.write(`${prefix(stateName, roleName, phase)} ${s.dim("still running…\n")}`);
    }, HEARTBEAT_MS);
  }

  const bindings = [
    [
      "stateEnter",
      (p) => {
        stdout.write(`\n${s.bold("→")} ${s.cyan(p.stateName)} ${s.dim("role")} ${p.roleName} ${s.dim("provider")} ${p.providerName}\n`);
      },
    ],
    [
      "providerStart",
      (p) => {
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
    ...(quiet
      ? []
      : [
          [
            "providerStdout",
            (p) => {
              bumpProviderOutputActivity();
              if (!p.chunk) return;
              for (const line of String(p.chunk).split(/\r?\n/)) {
                if (line.length === 0) continue;
                stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${line}\n`);
              }
            },
          ],
          [
            "providerStderr",
            (p) => {
              bumpProviderOutputActivity();
              if (!p.chunk) return;
              for (const line of String(p.chunk).split(/\r?\n/)) {
                if (line.length === 0) continue;
                stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${s.yellow(line)}\n`);
              }
            },
          ],
        ]),
    [
      "providerExit",
      (p) => {
        clearProviderHeartbeat();
        const ok = p.status === "ok";
        const mark = ok ? s.green("✓") : s.yellow("✗");
        stdout.write(
          `${mark} ${p.phase} ${s.dim(`${p.status}`)} ${s.dim(`exit ${p.exit_code ?? "?"}`)} ${s.dim(`${p.durationMs}ms`)}\n`,
        );
      },
    ],
    [
      "summary",
      (p) => {
        stdout.write(`${s.bold("summary")} ${s.dim(p.stateName)}: ${(p.text ?? "").trim()}\n`);
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
};
