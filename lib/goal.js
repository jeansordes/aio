const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline/promises");
const { EventEmitter } = require("node:events");
const { stripVTControlCharacters } = require("node:util");
const YAML = require("yaml");
const { providersConfigTemplate } = require("./setup");
const { buildProviderArgs, readConfigFile, readProvidersFile } = require("./workflow");
const { attachTermSink } = require("./term-sink");

const DEFAULT_MAX_TURNS = 10;
const REPORT_LIMIT = 64 * 1024;
const WINDOWS = process.platform === "win32";

function providersFor(root, env) {
  const config = readConfigFile(root);
  const file = path.join(root, ".aio", config.providersFile ?? "providers.yaml");
  const providers = new Map(Object.entries({
    cursor: YAML.parse(providersConfigTemplate()).providers.cursor,
    codex: {
      command: "codex",
      args: ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-"],
      promptInput: "stdin",
    },
  }));
  if (fs.existsSync(file)) {
    for (const [name, provider] of Object.entries(readProvidersFile(root, config).providers)) {
      if (provider.status !== "not_configured") providers.set(name, provider);
    }
  }
  return new Map([...providers].filter(([, p]) => p.command &&
    (p.promptInput === "stdin" || p.args?.some((arg) => String(arg).includes("{{prompt}}"))) &&
    commandExists(p.command, root, env)));
}

function commandExists(command, root, env) {
  const directories = /[/\\]/.test(command) ? [""] : (env.PATH ?? "").split(path.delimiter);
  const extensions = WINDOWS && !path.extname(command)
    ? (env.PATHEXT ?? ".EXE;.COM").split(";") : [""];
  return directories.some((dir) => extensions.some((ext) => {
    const file = path.resolve(root, dir, command + ext);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }));
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function saveState(file, state) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function openSession(root) {
  const dir = path.join(root, ".aio", "sessions", "goal");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const lock = path.join(dir, "lock");
  try {
    fs.writeFileSync(lock, process.pid + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Goal session is locked. If aio and its harness are no longer running, remove ${lock} and reopen aio.`);
  }
  return { dir, file: path.join(dir, "session.json"), close: () => fs.unlinkSync(lock) };
}

function safeText(text) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function turnPrompt(state, reportPath) {
  return [
    "Work on the user's goal below. Make useful progress in this turn and check the success criteria.",
    "The project files and the checkpoint below persist between turns. Preserve user changes.",
    "After your work, write a JSON report at " + JSON.stringify(reportPath) + " (relative to the project root).",
    "Do not edit aio's session state. Use one of these report shapes:",
    '{"decision":"continue","summary":"What changed, what you checked, and the next useful step"}',
    '{"decision":"done","summary":"What was accomplished","evidence":["Concrete evidence for criterion 1", "..."]}',
    '{"decision":"blocked","summary":"What you accomplished and tried","request":"What only the user can provide or decide"}',
    "Use done only when every criterion is satisfied. Give one evidence entry per criterion, in order.",
    "Use blocked only when progress requires user intervention; keep working if a useful alternative exists.",
    "",
    "Objective: " + state.objective,
    "Success criteria:",
    ...state.criteria.map((c, i) => `${i + 1}. ${c}`),
    "User guidance: " + JSON.stringify(state.guidance),
    "Last saved checkpoint: " + (state.summary || "(none)"),
    ...(state.interrupted ? ["The prior attempt was interrupted. Inspect the current files before continuing."] : []),
  ].join("\n");
}

function readReport(file, criteriaCount) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > REPORT_LIMIT) throw new Error("Invalid report file.");
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const nonempty = (value) => typeof value === "string" && value.trim() !== "";
  if (!report || !nonempty(report.summary) ||
      !["continue", "done", "blocked"].includes(report.decision) ||
      (report.decision === "done" && (!Array.isArray(report.evidence) ||
        report.evidence.length !== criteriaCount || !report.evidence.every(nonempty))) ||
      (report.decision === "blocked" && !nonempty(report.request))) {
    throw new Error("The harness report has no valid decision, evidence, or request.");
  }
  return report;
}

function removeReport(file) {
  try {
    if (!fs.lstatSync(file).isDirectory()) fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function runTurn({ provider, root, env, prompt, signal, bus }) {
  const args = buildProviderArgs(provider, { prompt, projectRoot: root });
  const meta = { stateName: "goal", roleName: "agent", phase: "main" };
  // A separate process group lets aio stop tools spawned by the harness as well.
  const child = spawn(provider.command, args, {
    cwd: root,
    env: { ...env, GIT_CEILING_DIRECTORIES: root },
    detached: !WINDOWS,
    stdio: [provider.promptInput === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const started = Date.now();
  bus.emit("providerStart", { ...meta, providerCommand: provider.command });
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
      stream.on("data", (chunk) => bus.emit(event, { ...meta, chunk: safeText(chunk) }));
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
        (!error && (provider.success?.exit_codes ?? [0]).includes(code) ? "ok" : "failed");
      bus.emit("providerExit", { ...meta, status, exit_code: code, durationMs: Date.now() - started });
      resolve({ code, termSignal, error });
    });
  });
}

async function runGoalMode(options) {
  const root = path.resolve(options.projectRoot);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const session = openSession(root);
  const rl = createInterface({ input, output, terminal: true });
  const stop = new AbortController();
  let state;
  let active = false;
  let pauseRequested = false;
  const write = (line) => output.write(safeText(line) + "\n");
  const save = () => saveState(session.file, state);
  const quit = () => stop.abort();
  const onLine = (line) => {
    if (!active) return;
    if (/^q(uit)?$/i.test(line.trim())) quit();
    if (/^p(ause)?$/i.test(line.trim()) && !pauseRequested) {
      pauseRequested = true;
      write("Pause requested. Waiting for the current turn to finish…");
    }
  };
  rl.on("line", onLine);
  rl.on("close", quit);
  rl.on("SIGINT", quit);
  const signals = ["SIGINT", "SIGTERM", ...(WINDOWS ? [] : ["SIGHUP"])];
  for (const sig of signals) process.on(sig, quit);
  const question = async (prompt) => (await rl.question(prompt, { signal: stop.signal })).trim();

  try {
    state = readState(session.file);
    if (state?.inFlight) {
      Object.assign(state, { inFlight: false, interrupted: true, status: "paused",
        reason: "The last turn was interrupted and may have changed project files." });
      save();
    }
    for (const entry of fs.readdirSync(session.dir)) {
      if (/^report-[a-f0-9-]+\.json$/.test(entry)) removeReport(path.join(session.dir, entry));
    }
    write("aio — Goal mode");
    if (state && state.status !== "done") {
      write(`Saved goal: ${state.objective} (${state.turns} saved turns)`);
      if (state.reason) write(state.reason);
      let choice;
      do {
        choice = (await question("[R]esume, [N]ew goal, [Q]uit: ")).toLowerCase();
      } while (!["", "r", "n", "q"].includes(choice));
      if (choice === "q") return;
      if (choice === "n") state = null;
    } else {
      state = null;
    }

    const providers = providersFor(root, env);
    if (!state) {
      if (!providers.size) throw new Error("No usable harness. Install Cursor Agent or Codex, or configure .aio/providers.yaml.");
      const names = [...providers.keys()];
      let provider = names[0];
      if (names.length > 1) {
        let choice;
        do {
          choice = await question(`Harness (${names.map((name, i) => `${i + 1}: ${name}`).join(", ")}) [1]: `);
          provider = names[Number(choice || 1) - 1];
        } while (!provider);
      }
      let objective;
      do { objective = await question("What goal should aio work toward? "); } while (!objective);
      const criteria = [];
      write("How will you know it is done? Enter one criterion per line, then an empty line.");
      while (true) {
        const criterion = await question(`Criterion ${criteria.length + 1}: `);
        if (criterion) criteria.push(criterion);
        else if (criteria.length) break;
      }
      state = { objective, criteria, provider, guidance: [], summary: "", status: "paused", turns: 0 };
      save();
    } else {
      if (state.summary) write(state.summary);
      const guidance = await question("Add guidance, or press Enter to resume: ");
      if (guidance) {
        state.guidance.push(guidance);
        save();
      }
    }

    const provider = providers.get(state.provider);
    if (!provider) throw new Error(`Saved harness "${state.provider}" is unavailable. Restore it or start a new goal.`);
    const maxTurns = options.goalMaxTurns ?? DEFAULT_MAX_TURNS;
    let turnsThisRun = 0;
    const bus = new EventEmitter();
    const detach = attachTermSink(bus, { stdout: output, stderr: options.stderr ?? process.stderr });
    try {
      write(`Using ${state.provider}. Type p + Enter to pause, q + Enter or Ctrl+C to quit.`);
      while (!stop.signal.aborted) {
        const reportFile = path.join(session.dir, `report-${randomUUID()}.json`);
        const prompt = turnPrompt(state, path.relative(root, reportFile));
        Object.assign(state, { status: "running", inFlight: true });
        save();
        write(`\nTurn ${state.turns + 1}`);
        active = true;
        let report;
        let failure;
        try {
          const { code, termSignal, error } = await runTurn({ provider, root, env, prompt, signal: stop.signal, bus });
          if (!stop.signal.aborted) {
            if (error) throw error;
            if (!(provider.success?.exit_codes ?? [0]).includes(code)) {
              throw new Error(`Harness exited with ${termSignal ?? code}.`);
            }
            try {
              report = readReport(reportFile, state.criteria.length);
            } catch (error) {
              throw new Error(error.code === "ENOENT" ? "The harness did not write a turn report." : error.message);
            }
          }
        } catch (error) {
          failure = error.message;
        } finally {
          active = false;
          removeReport(reportFile);
        }

        if (stop.signal.aborted) {
          Object.assign(state, { status: "paused", inFlight: false, interrupted: true,
            reason: "The last turn was interrupted and may have changed project files." });
          save();
          write(`\n${state.reason} Reopen aio to resume.`);
          break;
        }

        Object.assign(state, { status: "paused", inFlight: false, interrupted: !report, reason: null });
        if (report) {
          state.turns++;
          turnsThisRun++;
          state.summary = report.summary;
          write(report.summary);
        }
        if (report?.decision === "done") {
          Object.assign(state, { status: "done", evidence: report.evidence });
          save();
          write("Goal complete. Evidence reported by the harness:");
          state.criteria.forEach((c, i) => write(`- ${c}: ${state.evidence[i]}`));
          break;
        }
        if (failure) state.reason = `Harness turn failed: ${failure} The project may contain changes from this turn.`;
        else if (report.decision === "blocked") state.reason = `Your input is needed: ${report.request}`;
        else if (pauseRequested) state.reason = "Paused at your request.";
        else if (turnsThisRun >= maxTurns) state.reason =
          `Paused after ${maxTurns} ${maxTurns === 1 ? "turn" : "turns"}. Review progress before continuing.`;
        save();

        if (state.reason) {
          write(state.reason);
          const guidance = await question("Press Enter to resume, add guidance and press Enter, or type q to quit: ");
          if (/^q(uit)?$/i.test(guidance)) break;
          if (guidance) state.guidance.push(guidance);
          save();
          pauseRequested = false;
          turnsThisRun = 0;
        }
      }
    } finally {
      detach();
    }
    return { goal: state.status };
  } catch (error) {
    if (!stop.signal.aborted || error.name !== "AbortError") throw error;
  } finally {
    for (const sig of signals) process.off(sig, quit);
    rl.close();
    session.close();
  }
}

module.exports = { runGoalMode };
