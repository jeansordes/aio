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

  if (quiet) {
    return () => {};
  }

  const prefix = (stateName, roleName, phase) =>
    s.dim(`[${stateName}/${roleName}${phase && phase !== "main" ? `/${phase}` : ""}]`);

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
      },
    ],
    [
      "providerStdout",
      (p) => {
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
        if (!p.chunk) return;
        for (const line of String(p.chunk).split(/\r?\n/)) {
          if (line.length === 0) continue;
          stdout.write(`${prefix(p.stateName, p.roleName, p.phase)} ${s.yellow(line)}\n`);
        }
      },
    ],
    [
      "providerExit",
      (p) => {
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
        stdout.write(`${s.yellow("error:")} ${p.message}\n`);
      },
    ],
  ];

  for (const [ev, fn] of bindings) {
    bus.on(ev, fn);
  }

  return () => {
    for (const [ev, fn] of bindings) {
      bus.off(ev, fn);
    }
  };
}

module.exports = {
  attachTermSink,
};
