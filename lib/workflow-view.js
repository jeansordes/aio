const { safeText } = require('./text');
const { wrap } = require('./terminal');
const { destinations } = require('./graph');
const { assistantVisibleText, toolCallSummaryLine, tryParseStreamJsonLine } = require('./harness-output');
const frames = ['|', '/', '-', '\\'];
function renderGraph(state, columns = 80, selected = state.current, frame = 0, animate = false) {
  const ids = Object.keys(state.workflow.nodes);
  return ids.map((id, index) => {
    const active = id === state.current;
    const mark = active ? (state.status === 'running' ? (animate ? frames[frame % frames.length] : '*') : state.status === 'paused' ? '!' : '✓') : state.results[id] ? '✓' : ' ';
    const badge = id === selected ? `>[${index + 1}]<` : ` [${index + 1}] `;
    const edges = destinations(state.workflow.nodes[id]).map(to => `[${ids.indexOf(to) + 1}]`).join(', ');
    return wrap(`${mark} ${badge}${edges ? ' → ' + edges : ''}`, Math.max(1, columns - 1));
  }).flat();
}
function attachWorkflowView(bus, { state, output, terminal }) {
  const ids = Object.keys(state.workflow.nodes), logs = {}, selections = {}, buffers = {};
  let selected = state.current, offset = 0, frame = 0, timer, live = false, lastFallback;
  function add(id, text) {
    (logs[id] ??= []).push(...safeText(String(text)).split(/\r?\n/).filter(Boolean));
    logs[id] = logs[id].slice(-200);
    if (!output.isTTY) output.write(safeText(`${id}: ${text}\n`));
  }
  function draw() {
    if (!live) return;
    const width = output.columns || 80, height = output.rows || 24;
    const graph = renderGraph(state, width, selected, frame++, Boolean(output.isTTY));
    const graphBudget = Math.max(1, Math.floor(height / 3));
    const number = ids.indexOf(selected) + 1;
    const graphAt = graph.findIndex(line => line.includes(`>[${number}]<`));
    const start = Math.max(0, Math.min(graphAt - Math.floor(graphBudget / 2), graph.length - graphBudget));
    const visible = graph.slice(start, start + graphBudget);
    const node = state.workflow.nodes[selected];
    const selection = selections[selected] ?? (state.current === selected ? state.selection : state.history.filter(h => h.node === selected).at(-1)?.selection);
    const details = [`${number} — ${node.name ?? selected} (${node.type})`,
      ...(node.modelProfile ? [`Profile: ${node.modelProfile}`, ...(selection ? [`Requested model: ${selection.harness} / ${selection.model} (#${selection.index})`] : (state.modelConfig.profiles[node.modelProfile] ?? []).map((v, i) => `${i + 1}. ${v.harness} / ${v.model}`))] : []),
      ...(node.prompt ? [node.prompt] : []),
      ...(node.command ? [`Command: ${node.command} ${JSON.stringify(node.args)}`, `Timeout: ${node.timeoutMs ?? 600000} ms`] : []),
      ...(node.criteria ?? []).map((c, i) => `Criterion ${i + 1}: ${c}`),
      ...(node.routes ?? []).map(r => `→ ${ids.indexOf(r.to) + 1}: ${r.description}`),
      ...(state.results[selected] ? [`Result: ${state.results[selected].summary}`, ...(state.results[selected].criteria ?? []).map((c, i) => `${i + 1}. ${c.status}: ${c.evidence}`)] : []),
      ...(selected === state.current && state.reason ? [state.reason] : []),
      'Recent output:', ...(logs[selected] ?? []).slice(-30),
    ].flatMap(line => wrap(line, Math.max(1, width - 1)));
    if (height < 12 || width < 30) {
      const compactWidth = Math.max(1, width - 1);
      const budget = Math.max(1, height - 4);
      offset = Math.min(offset, Math.max(0, details.length - budget));
      const edges = destinations(node).map(to => ids.indexOf(to) + 1).join(',');
      terminal.screen([
        `${state.status} · active ${ids.indexOf(state.current) + 1}`.slice(0, compactWidth),
        `>[${number}]<${edges ? '→' + edges : ''}`.slice(0, compactWidth),
        ...details.slice(offset, offset + budget),
      ], '←→ f Pg p q'.slice(0, compactWidth));
      return;
    }
    const head = [`${state.workflow.name} · ${state.status} · active ${ids.indexOf(state.current) + 1}`,
      ...visible, ...(graph.length > graphBudget ? [`Graph lines ${start + 1}-${start + visible.length}/${graph.length}`] : []),
      ...(lastFallback ? [lastFallback] : []), '────────────────────────'].flatMap(line => wrap(line, Math.max(1, width - 1)));
    const budget = Math.max(1, height - head.length - 4);
    offset = Math.min(offset, Math.max(0, details.length - budget));
    terminal.screen([...head, ...details.slice(offset, offset + budget), ...(details.length > budget ? [`Detail lines ${offset + 1}-${Math.min(offset + budget, details.length)}/${details.length}`] : [])],
      '← ↑ / → ↓ inspect · f active · PgUp/PgDn scroll · p pause · q stop');
  }
  const key = (text, event) => {
    let index = ids.indexOf(selected);
    if (['left', 'up'].includes(event.name)) { selected = ids[(index + ids.length - 1) % ids.length]; offset = 0; }
    if (['right', 'down', 'tab'].includes(event.name)) { selected = ids[(index + 1) % ids.length]; offset = 0; }
    if (text === 'f') { selected = state.current; offset = 0; }
    if (event.name === 'pageup') offset = Math.max(0, offset - 5);
    if (event.name === 'pagedown') offset += 5;
    draw();
  };
  function feed(kind, id, chunk) {
    const key = `${id}:${kind}`;
    buffers[key] = (buffers[key] ?? '') + chunk;
    const lines = buffers[key].split(/\r?\n/); buffers[key] = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = tryParseStreamJsonLine(line);
      const text = event ? assistantVisibleText(event) ?? toolCallSummaryLine(event) ?? (event.is_error ? event.result : '') : line;
      if (text) add(id, text);
    }
    if (buffers[key].length > 65536) { add(id, buffers[key]); buffers[key] = ''; }
  }
  const bindings = [
    ['nodeEnter', ({ node }) => { if (!output.isTTY) output.write(renderGraph(state).join('\n') + '\n'); add(node, 'Started'); }],
    ['providerStdout', ({ stateName, chunk }) => feed('stdout', stateName, chunk)],
    ['providerStderr', ({ stateName, chunk }) => feed('stderr', stateName, chunk)],
    ['providerExit', ({ stateName }) => { feed('stdout', stateName, '\n'); feed('stderr', stateName, '\n'); }],
    ['modelSelected', value => { selections[value.node] = value; add(value.node, `Profile ${value.profile} #${value.index}: ${value.harness} / ${value.model} (requested)`); }],
    ['fallback', value => { lastFallback = `Fallback ${value.profile} #${value.index}: ${value.harness} / ${value.model}: ${value.reason}`; add(value.node, lastFallback); }],
    ['checkpoint', ({ node, report }) => add(node, report.summary)],
    ['paused', ({ node, reason }) => add(node, reason)],
    ['notificationWarning', ({ message }) => add(state.current, message)],
  ];
  for (const [event, listener] of bindings) bus.on(event, listener);
  return {
    start() { live = true; terminal.on('key', key); terminal.redraw = draw; if (output.isTTY) timer = setInterval(draw, 120); draw(); },
    stop() { live = false; clearInterval(timer); terminal.off('key', key); terminal.redraw = null; },
    close() { this.stop(); for (const [event, listener] of bindings) bus.off(event, listener); },
  };
}
module.exports = { renderGraph, attachWorkflowView };
