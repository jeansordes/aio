const { safeText } = require("./text");
const { assistantVisibleText, toolCallSummaryLine, tryParseStreamJsonLine } = require("./harness-output");

function wrap(text, width) {
  const chars = [...safeText(String(text)).replace(/\r/g, "")];
  const lines = [];
  for (const line of chars.join("").split("\n")) {
    const parts = [...line];
    if (!parts.length) lines.push("");
    while (parts.length) lines.push(parts.splice(0, width).join(""));
  }
  return lines;
}

function renderGraph(state, columns = 80) {
  const width = Math.max(1, columns - 1);
  const lines = [`Workflow: ${state.workflow.name} | ${state.status}`];
  for (const [id, node] of Object.entries(state.workflow.nodes)) {
    const current = state.current === id;
    const mark = current ? (state.status === "done" ? "x" : state.status === "paused" ? "!" : ">")
      : state.results[id] ? "x" : " ";
    const detail = current ? ` | visit ${state.visit}, turn ${state.turns}` : "";
    lines.push(`[${mark}] ${id} (${node.type})${detail}`);
    if (node.type === "goal") {
      lines.push(` | goal: ${node.objective}`);
      lines.push(` +--> ${id} : continue`);
      lines.push(` +--> ${node.next} : success`);
    }
    if (node.type === "route") {
      for (const route of node.routes) lines.push(` +--> ${route.to} : ${route.description}`);
    }
  }
  lines.push("[>] active  [!] paused  [x] last result / end");
  return lines.flatMap((line) => wrap(line, width));
}

function attachWorkflowView(bus, { state, output, rl }) {
  let lines = [];
  let timer;
  let live = false;
  const buffers = { stdout: "", stderr: "" };
  const tty = Boolean(output.isTTY);
  const add = (text) => {
    lines.push(...safeText(String(text)).split(/\r?\n/).filter(Boolean));
    lines = lines.slice(-200);
    if (!tty || !live) output.write(safeText(String(text)) + "\n");
    schedule();
  };
  function draw() {
    timer = null;
    if (!live || !tty) return;
    const width = Math.max(1, (output.columns || 80) - 1);
    const height = Math.max(6, output.rows || 24);
    let graph = renderGraph(state, width + 1);
    const graphBudget = Math.max(2, height - 8);
    if (graph.length > graphBudget) {
      const active = graph.findIndex((line) => line.startsWith("[>]") || line.startsWith("[!]"));
      const start = Math.max(0, Math.min(active - 1, graph.length - graphBudget + 1));
      graph = [`Graph lines ${start + 1}-${start + graphBudget - 1}/${graph.length}`,
        ...graph.slice(start, start + graphBudget - 1)];
    }
    const logBudget = Math.max(1, height - graph.length - 4);
    const logs = lines.flatMap((line) => wrap(line, width)).slice(-logBudget);
    output.write("\x1b[H\x1b[2J" + [...graph, "-".repeat(Math.min(width, 40)), ...logs,
      ...wrap("p + Enter: pause | q + Enter: quit", width)].join("\n") + "\n");
    rl.prompt(true);
  }
  function schedule() {
    if (live && tty && !timer) timer = setTimeout(draw, 50);
  }
  function feed(kind, chunk) {
    buffers[kind] += chunk;
    const complete = buffers[kind].split(/\r?\n/);
    buffers[kind] = complete.pop();
    for (const line of complete) {
      if (!line) continue;
      const event = tryParseStreamJsonLine(line);
      if (!event) add(line);
      else {
        const text = assistantVisibleText(event) ?? toolCallSummaryLine(event);
        if (text) add(text);
        else if (event.type === "result" && event.is_error) add(event.result ?? "Harness error");
      }
    }
    if (buffers[kind].length > 65536) {
      add(buffers[kind]);
      buffers[kind] = "";
    }
  }
  const bindings = [
    ["nodeEnter", ({ node, visit, turn, harness }) => {
      if (!tty) output.write(renderGraph(state, output.columns || 80).join("\n") + "\n");
      add(`Node ${node}, visit ${visit}, turn ${turn} (${harness})`);
    }],
    ["providerStdout", ({ chunk }) => feed("stdout", chunk)],
    ["providerStderr", ({ chunk }) => feed("stderr", chunk)],
    ["providerExit", () => { feed("stdout", "\n"); feed("stderr", "\n"); }],
    ["checkpoint", ({ node, report }) => add(`${node}: ${report.summary}`)],
    ["transition", ({ from, to }) => add(`${from} -> ${to}`)],
    ["paused", ({ reason }) => add(reason)],
    ["completed", () => add("Workflow complete.")],
    ["notificationWarning", ({ message }) => add(message)],
  ];
  for (const [event, listener] of bindings) bus.on(event, listener);
  const resize = () => schedule();
  output.on("resize", resize);
  return {
    start() {
      live = true;
      if (tty) output.write("\x1b[?1049h");
      rl.setPrompt("> ");
      draw();
    },
    stop() {
      if (!live) return;
      live = false;
      clearTimeout(timer);
      timer = null;
      if (tty) output.write("\x1b[?1049l");
      output.write(renderGraph(state, output.columns || 80).join("\n") + "\n");
      if (tty && lines.length) output.write(lines.slice(-6).join("\n") + "\n");
      for (const [id, report] of Object.entries(state.results)) {
        if (report.decision === "done") {
          output.write(`Evidence reported for ${id}:\n`);
          state.workflow.nodes[id].criteria.forEach((criterion, i) =>
            output.write(safeText(`- ${criterion}: ${report.evidence[i]}\n`)));
        }
      }
    },
    close() {
      this.stop();
      for (const [event, listener] of bindings) bus.off(event, listener);
      output.off("resize", resize);
    },
  };
}

module.exports = { renderGraph, attachWorkflowView };
