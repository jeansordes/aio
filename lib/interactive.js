const path = require("node:path");
const { createInterface } = require("node:readline/promises");
const { EventEmitter } = require("node:events");
const { loadHarnesses, saveDefault, available, resolveHarness } = require("./harnesses");
const { listWorkflows, readWorkflow, standaloneGoal } = require("./graph");
const { openSession } = require("./session");
const { runUntilPause } = require("./runtime");
const { attachWorkflowView } = require("./workflow-view");
const { safeText } = require("./text");
const { attachNotifications } = require("./notifications");

async function runInteractive(options = {}) {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const store = openSession(root);
  const rl = createInterface({ input, output, terminal: true });
  const controller = new AbortController();
  let running = false;
  let requestedPause = false;
  let view;
  let detach;
  let notifications;
  const quit = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])];
  for (const signal of signals) process.on(signal, quit);
  rl.on("SIGINT", quit);
  rl.on("close", quit);
  output.on("error", quit);
  const write = (text) => output.write(safeText(text) + "\n");
  rl.on("line", (line) => {
    if (!running) return;
    if (/^q(uit)?$/i.test(line.trim())) quit();
    if (/^p(ause)?$/i.test(line.trim())) requestedPause = true;
  });
  const ask = async (message) => (await rl.question(message, { signal: controller.signal })).trim();
  async function choose(message, values) {
    for (;;) {
      write(message);
      values.forEach((value, index) => write(`${index + 1}. ${value.label}`));
      const answer = await ask("Choose [1], or q to quit: ");
      if (answer.toLowerCase() === "q") { quit(); return null; }
      const index = Number(answer || "1") - 1;
      if (Number.isInteger(index) && values[index]) return values[index].value;
      write("Choose a listed number.");
    }
  }
  try {
    write("aio — Goals and workflows");
    let state = store.load();
    if (state && state.status !== "done") {
      write(`Saved session: ${state.workflow.name} at ${state.current}`);
      if (state.reason) write(state.reason);
      const choice = await choose("Continue working", [
        { label: "Resume saved session", value: "resume" }, { label: "Start a new session", value: "new" },
      ]);
      if (!choice) return;
      if (choice === "new") state = null;
    } else state = null;
    const resuming = Boolean(state);
    const loaded = loadHarnesses(env);
    if (!state) {
      let harnessId = loaded.config.defaultHarness;
      if (!harnessId || !available(loaded.harnesses[harnessId], env)) {
        const ids = Object.keys(loaded.harnesses).filter((id) => available(loaded.harnesses[id], env));
        if (!ids.length) throw new Error(`No usable harness. Install Cursor Agent or Codex, or edit ${loaded.file}.`);
        harnessId = await choose("Default harness for your projects", ids.map((id) => ({ label: id, value: id })));
        if (!harnessId) return;
        saveDefault(loaded, harnessId);
      }
      const workflows = listWorkflows(root);
      const selected = await choose("Start a session", [
        { label: "Goal — describe an objective", value: "goal" },
        ...workflows.map((workflow) => ({ label: `Workflow — ${workflow.name}`, value: workflow.file })),
      ]);
      if (!selected) return;
      let workflow;
      if (selected === "goal") {
        let objective;
        do { objective = await ask("What goal should aio work toward? "); } while (!objective);
        const criteria = [];
        write("Enter one success criterion per line, then an empty line.");
        while (true) {
          const criterion = await ask(`Criterion ${criteria.length + 1}: `);
          if (criterion) criteria.push(criterion);
          else if (criteria.length) break;
        }
        workflow = standaloneGoal(objective, criteria);
      } else workflow = readWorkflow(selected);
      const defaults = { harness: harnessId, model: loaded.config.defaultModel };
      // Reject unusable node assignments before replacing an existing session.
      for (const node of Object.values(workflow.nodes)) {
        if (node.type !== "end") resolveHarness(node, defaults, loaded, env);
      }
      state = store.start(workflow, defaults);
    } else {
      const guidance = await ask("Add guidance, or press Enter to resume: ");
      if (guidance) {
        state.guidance.push({ node: state.current, text: guidance });
        store.save(state);
      }
    }
    const bus = new EventEmitter();
    detach = store.attach(bus);
    view = attachWorkflowView(bus, { state, output, rl });
    notifications = attachNotifications(bus, { config: loaded.config.notifications, state, projectRoot: root, env });
    let event = resuming ? "resumed" : "started";
    while (!controller.signal.aborted) {
      requestedPause = false;
      running = true;
      view.start();
      bus.emit(event);
      event = "resumed";
      try {
        await runUntilPause({ root, state, store, loaded, env, bus, signal: controller.signal,
          pauseRequested: () => requestedPause });
      } finally {
        await notifications.flush();
        running = false;
        view.stop();
      }
      if (state.status === "done" || controller.signal.aborted) break;
      write(state.reason);
      const guidance = await ask("Press Enter to resume, add guidance, or type q to quit: ");
      if (/^q(uit)?$/i.test(guidance)) break;
      if (guidance) {
        state.guidance.push({ node: state.current, text: guidance });
        store.save(state);
      }
    }
    return { status: state.status };
  } catch (error) {
    if (!controller.signal.aborted || error.name !== "AbortError") throw error;
  } finally {
    await notifications?.close();
    view?.close();
    detach?.();
    for (const signal of signals) process.off(signal, quit);
    rl.close();
    output.off("error", quit);
    store.close();
  }
}

module.exports = { runInteractive };
