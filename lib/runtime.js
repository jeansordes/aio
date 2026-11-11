const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { nonempty, check, available } = require('./harnesses');
const { resolveEntry, fallbackReason } = require('./model-profiles');
const { runHarness } = require('./harness-process');

function buildNodePrompt(state, reportPath, sessionPath) {
  const node = state.workflow.nodes[state.current];
  return [
    'You are executing one node of an aio workflow. Preserve existing user changes.',
    'Only work within the project. Do not edit aio session files except the report requested below.',
    'Write your final JSON report to ' + JSON.stringify(reportPath) + ' (relative to the project root).',
    'Full prior results are available for reading at ' + JSON.stringify(sessionPath) + '.',
    `Current node: ${state.current}; visit: ${state.visit}.`,
    'Recent results by node: ' + JSON.stringify(state.results),
    'User guidance: ' + JSON.stringify(state.guidance),
    ...(state.interrupted ? ['A prior invocation failed or was interrupted and may have modified files. Inspect actual project state before continuing; preserve completed work. Prior attempt: ' + (state.lastAttempt ?? '')] : []),
    node.prompt,
    'If progress requires the user, report {"decision":"blocked","summary":"progress and attempts","request":"what you need"}.',
    ...(node.type === 'action' ? [
      'Perform the requested work once. The next routing node owns assessment of the project criteria.',
      'Use prior routing findings to address corrections. Report {"decision":"done","summary":"work performed and remaining observations"}.',
    ] : [
      'Choose the next node independently. Inspect project files and relevant evidence. Do not modify project work or perform the action; only write your report.',
      'Allowed routes: ' + JSON.stringify(node.routes),
      'Report {"decision":"route","to":"one allowed destination","summary":"justification"}.',
      ...(node.criteria ? [
        'Success criteria: ' + JSON.stringify(node.criteria),
        'Include "criteria": [{"status":"satisfied|not_satisfied|indeterminate","evidence":"specific proof or explanation"}] with exactly one entry per criterion in order.',
        'Only select an end node when every criterion is satisfied. If essential information is missing or a criterion is indeterminate, report blocked and ask the user.',
        'End destinations: ' + JSON.stringify(node.routes.filter(r => state.workflow.nodes[r.to].type === 'end').map(r => r.to)),
      ] : []),
    ]),
  ].join('\n\n');
}
function validateReport(report, node, workflow) {
  check(report && nonempty(report.summary), 'Missing report summary.');
  if (report.decision === 'blocked') check(nonempty(report.request), 'A blocked report must explain what the user needs to provide.');
  else if (node.type === 'action') check(report.decision === 'done', 'An action must report done or blocked.');
  else check(report.decision === 'route' && node.routes.some(r => r.to === report.to), 'Routing must select an allowed destination.');
  if (node.criteria && report.decision !== 'blocked') {
    check(Array.isArray(report.criteria) && report.criteria.length === node.criteria.length &&
      report.criteria.every(c => c && ['satisfied', 'not_satisfied', 'indeterminate'].includes(c.status) && nonempty(c.evidence)),
    'Validation requires a status and evidence for every criterion.');
    check(!report.criteria.some(c => c.status === 'indeterminate'), 'Indeterminate criteria require a blocked report and a user request.');
    if (workflow?.nodes[report.to]?.type === 'end') check(report.criteria.every(c => c.status === 'satisfied'), 'Cannot finish: every criterion must be satisfied.');
  }
  return Object.fromEntries(['decision', 'summary', 'request', 'criteria', 'to'].filter(k => report[k] !== undefined).map(k => [k, report[k]]));
}
function readReport(file, node, workflow) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= 65536, 'Invalid or oversized report file.');
    return validateReport(JSON.parse(fs.readFileSync(fd, 'utf8')), node, workflow);
  } finally { fs.closeSync(fd); }
}
function streamErrors(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => {
    try { const event = JSON.parse(line); return event.is_error || ['error', 'turn.failed'].includes(event.type) ? [JSON.stringify(event)] : []; }
    catch { return []; }
  });
}
function failureDiagnostic(result) {
  // Structured stream error records may be on stdout. Ordinary assistant prose is excluded.
  const errors = streamErrors(result.stdout);
  return [result.stderr, ...errors].join('\n');
}
async function runUntilPause({ root, state, store, env = process.env, signal, pauseRequested = () => false, bus = new EventEmitter() }) {
  let invocations = 0;
  const unavailable = new Set();
  const limit = state.workflow.maxInvocations ?? 100;
  function pause(reason, interrupted = state.interrupted) {
    Object.assign(state, { status: 'paused', reason, interrupted, inFlight: false });
    store.save(state); bus.emit('paused', { node: state.current, reason }); return state;
  }
  while (true) {
    if (signal.aborted) return pause('Stopped. Reopen aio to resume.');
    const node = state.workflow.nodes[state.current];
    if (node.type === 'end') {
      Object.assign(state, { status: 'done', reason: null, inFlight: false });
      store.save(state); bus.emit('completed', { node: state.current }); return state;
    }
    if (invocations >= limit) return pause('Invocation limit reached. Review progress before continuing.');
    let report;
    let selection;
    let failure;
    const entries = node.type === 'script' ? [null] : state.modelConfig?.profiles[node.modelProfile];
    if (!entries?.length) return pause(`Missing or empty model profile: ${node.modelProfile}`);
    for (let index = 0; index < entries.length; index++) {
      if (signal.aborted) return pause('Stopped.');
      if (invocations >= limit) return pause('Invocation limit reached. Review progress before continuing.');
      const entry = entries[index];
      const key = entry && JSON.stringify(entry);
      if (key && unavailable.has(key)) continue;
      let harness;
      if (entry) {
        const defined = state.modelConfig.harnesses[entry.harness];
        if (!defined) return pause(`Unknown harness: ${entry.harness}`);
        if (!available(defined, env)) {
          unavailable.add(key);
          bus.emit('fallback', { node: state.current, profile: node.modelProfile, index: index + 1, ...entry, reason: 'executable unavailable' });
          continue;
        }
        try { harness = resolveEntry(entry, state.modelConfig, env); }
        catch (error) { return pause(error.message); }
        selection = { profile: node.modelProfile, index: index + 1, ...entry };
        state.selection = selection;
        bus.emit('modelSelected', { node: state.current, ...selection });
      } else harness = { command: node.command, args: node.args };
      const reportFile = path.join(store.dir, `report-${randomUUID()}.json`);
      const prompt = entry ? buildNodePrompt(state, path.relative(root, reportFile), path.relative(root, store.file)) : '';
      Object.assign(state, { status: 'running', inFlight: true, reason: null });
      store.save(state);
      bus.emit('nodeEnter', { node: state.current, visit: state.visit, turn: state.turns + 1, harness: entry?.harness ?? node.command, model: entry?.model });
      let retryReason;
      invocations++;
      try {
        const result = await runHarness({ harness, root, env, prompt, signal, bus, nodeId: state.current,
          ...(entry ? {} : { rawArgs: node.args, timeoutMs: node.timeoutMs ?? 600000 }) });
        if (signal.aborted) return pause('The last invocation was interrupted and may have changed project files.', true);
        if (result.timedOut) throw new Error('Script timed out. Inspect its output before retrying.');
        if (result.error) throw result.error;
        if (!(harness.successExitCodes ?? [0]).includes(result.code) || entry && streamErrors(result.stdout).length) {
          retryReason = entry && fallbackReason(failureDiagnostic(result));
          if (!retryReason) throw new Error(`Process exited with ${result.termSignal ?? result.code}. ${result.stderr.slice(-1000)}`);
          unavailable.add(key);
          Object.assign(state, { interrupted: true, inFlight: false, lastAttempt: `${entry.harness}/${entry.model}: ${retryReason}. Output is saved in session logs.` });
          store.save(state);
          bus.emit('fallback', { node: state.current, ...selection, reason: retryReason });
        } else if (entry) report = readReport(reportFile, node, state.workflow);
        else if (node.next) report = { decision: 'done', summary: 'Script completed successfully.' };
        else {
          check(!result.stdoutOverflow, 'Script routing output exceeds 64 KiB.');
          const value = JSON.parse(result.stdout);
          report = validateReport({ ...value, decision: 'route' }, node, state.workflow);
        }
      } catch (error) { failure = error.code === 'ENOENT' ? 'The executable or required agent report is missing.' : error.message; }
      finally {
        try { if (!fs.lstatSync(reportFile).isDirectory()) fs.unlinkSync(reportFile); }
        catch (error) { if (error.code !== 'ENOENT') failure ??= error.message; }
      }
      if (failure) return pause(`Invocation failed: ${failure} Project files may already contain changes.`, true);
      if (retryReason) {
        if (pauseRequested()) return pause('Paused at your request.');
        continue;
      }
      break;
    }
    if (!report) return pause(`No available model remains for profile ${node.modelProfile}. Configure profiles or resume to try again.`);
    const from = state.current;
    state.turns++;
    state.history.push({ node: from, visit: state.visit, turn: state.turns, report, ...(selection ? { selection } : {}) });
    state.results[from] = report;
    Object.assign(state, { inFlight: false, interrupted: false, summary: report.summary });
    const to = report.decision === 'done' ? node.next : report.decision === 'route' ? report.to : null;
    const visit = state.visit;
    if (to) Object.assign(state, { current: to, visit: state.visit + 1, turns: 0, summary: '', selection: null });
    store.save(state);
    bus.emit('checkpoint', { node: from, visit, report });
    if (to) bus.emit('transition', { from, to });
    if (report.decision === 'blocked') return pause(`Your input is needed: ${report.request}`);
    if (state.workflow.nodes[state.current].type !== 'end' && pauseRequested()) return pause('Paused at your request.');
  }
}
module.exports = { runUntilPause, buildNodePrompt, validateReport, failureDiagnostic };
