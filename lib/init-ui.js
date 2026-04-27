/**
 * Small TTY-aware helpers for aio init / setup presentation (no extra dependencies).
 */

function createStyle(useColor) {
  if (!useColor) {
    return {
      bold: (s) => s,
      dim: (s) => s,
      cyan: (s) => s,
      green: (s) => s,
      yellow: (s) => s,
    };
  }
  return {
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  };
}

function writeLines(stream, lines) {
  for (const line of lines) {
    stream.write(`${line}\n`);
  }
}

function formatProbeLabel(entry) {
  return `${entry.command} ${entry.args.join(" ")}`;
}

/** Prints detected CLI probes before optional interactive provider selection. */
function writeDetectedProviders(stream, style, catalog, detectedNames) {
  const s = style;
  const entries = detectedNames
    .map((name) => catalog.find((e) => e.name === name))
    .filter((e) => e != null);

  stream.write("\n");
  if (entries.length === 0) {
    return;
  }
  if (entries.length === 1) {
    stream.write(`${s.bold("Detected provider CLI")}\n`);
    stream.write(`  ${s.green("✓")} ${entries[0].name} (${formatProbeLabel(entries[0])})\n`);
    stream.write(`${s.dim("Using this as the default for roles and workflows.")}\n`);
    return;
  }
  stream.write(`${s.bold("Detected provider CLIs")}\n`);
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    stream.write(`  ${s.bold(String(i + 1))}. ${e.name} (${formatProbeLabel(e)})\n`);
  }
  stream.write("\n");
}

function writeInitIntro(stream, style, { detected, defaultDescription }) {
  const s = style;
  const width = 44;
  const bar = "─".repeat(width);
  writeLines(stream, [
    "",
    s.cyan(bar),
    s.cyan("  ") + s.bold("aio init") + s.dim(" — scaffold .aio and choose tracking"),
    s.cyan(bar),
    "",
    s.dim("Creates .aio/ (config, providers, roles, workflows) if missing."),
    s.dim("Existing files are left untouched."),
    "",
    s.bold("Task / roadmap file"),
    detected
      ? `  ${s.green("Found:")} ${s.bold(detected)}`
      : `  ${s.yellow("No known tracker in this folder yet.")} ${s.dim("(see below)")}`,
    "",
    s.dim("What happens when you press Enter:"),
    `  ${s.bold("→")} ${defaultDescription}`,
    "",
    s.dim("Other choices:"),
    `  ${s.bold("s")}  Create ${s.bold("specs/")} + ${s.bold("specs/roadmap.csv")} (Johnny Decimal–style layout)`,
    `  ${s.bold("n")}  No tracking file (${s.dim("tracking.file: null")})`,
    `  ${s.dim("…")}  Or type any relative path to your own tracker file`,
    "",
  ]);
}

function buildInitDoneLines(result, style) {
  const s = style;
  const { projectRoot, created, skipped, trackingFile, scaffoldSpecs, defaultProvider, discordConfigured } = result;
  const createdN = created.length;
  const skippedN = skipped.length;
  let trackingLine;
  if (trackingFile == null) {
    trackingLine = `${s.dim("Tracking:")} ${s.dim("none (workflows run without a roadmap path)")}`;
  } else {
    const extra = scaffoldSpecs ? ` ${s.dim("(specs/ layout created)")}` : "";
    trackingLine = `${s.dim("Tracking:")} ${trackingFile}${extra}`;
  }
  const providerLine =
    defaultProvider != null
      ? `${s.dim("Default provider:")} ${s.bold(defaultProvider)} (${s.dim("roles + workflows")})`
      : null;

  const lines = [
    "",
    `${s.green("✓")} ${s.bold("Configured")} ${s.dim(projectRoot)}`,
    `${s.dim("·")} ${createdN} path${createdN === 1 ? "" : "s"} added, ${skippedN} already present`,
    trackingLine,
  ];
  if (providerLine) {
    lines.push(providerLine);
  }
  if (discordConfigured) {
    lines.push(`${s.dim("Discord:")} ${s.bold(".aio/.env")} ${s.dim("(webhook saved; .env is gitignored)")}`);
  }
  lines.push("");
  return lines;
}

function writeInitDone(stream, result, useColor) {
  const style = createStyle(useColor);
  writeLines(stream, buildInitDoneLines(result, style));
}

module.exports = {
  buildInitDoneLines,
  createStyle,
  formatProbeLabel,
  writeDetectedProviders,
  writeInitDone,
  writeInitIntro,
  writeLines,
};
