const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadHarnesses } = require('./harnesses');
const { loadProfiles, snapshotProfiles } = require('./model-profiles');
const { listWorkflows, readWorkflow, standaloneGoal } = require('./graph');
const { openSession } = require('./session');
const { runUntilPause } = require('./runtime');
const { attachWorkflowView } = require('./workflow-view');
const { attachNotifications } = require('./notifications');
const { Terminal } = require('./terminal');
const { setupProfiles, editProfiles, collectCriteria } = require('./interactive-settings');

async function runInteractive(options = {}) {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const input = options.stdin ?? process.stdin, output = options.stdout ?? process.stdout, env = options.env ?? process.env;
  const controller = new AbortController();
  const quit = () => controller.abort();
  const signals = ['SIGINT','SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])];
  for (const signal of signals) process.on(signal, quit);
  input.on('end',quit); input.on('close',quit); output.on('error',quit);
  const terminal = new Terminal(input, output, controller.signal);
  terminal.on('interrupt',quit);
  let store;
  try {
    store = openSession(root);
    while (!controller.signal.aborted) {
      let saved, warning;
      try { saved = store.load(); if (saved?.incompatible) { warning = saved.reason; saved = null; } }
      catch (error) { warning = error.message; }
      const menu = await terminal.choose('aio — Workflows and Goals' + (warning ? `\n${warning}` : ''), [
        {label:'Workflow — choose a project workflow',value:'workflow'}, {label:'Goal — describe an objective',value:'goal'}, null,
        ...(saved && saved.status !== 'done' ? [{label:`Resume — ${saved.workflow.name}`,value:'resume'}] : []),
        {label:'Settings',value:'settings'}, {label:'Version',value:'version'}, {label:'Help',value:'help'},
        {label:'Update',value:'update'}, {label:'Quit',value:'quit'},
      ]);
      if (!menu || menu === 'quit') break;
      try {
        if (menu === 'version' || menu === 'help') {
          const cli = require('./cli');
          await terminal.message(menu === 'version' ? 'Version' : 'Help', menu === 'version' ? cli.formatVersionBlock(options) : cli.getHelpText(options));
          continue;
        }
        if (menu === 'update') {
          const messages = [];
          terminal.screen(['Checking for updates…']);
          input.setRawMode?.(false);
          let result;
          try { result = await (options.updatePackage ?? require('./cli').updatePackage)({ ...options, write: text => messages.push(text) }); }
          finally { input.setRawMode?.(true); }
          await terminal.message('Update', messages.join('\n') || 'Update check complete.');
          if (result?.status === 'updated') break;
          continue;
        }
        const loaded = loadHarnesses(env);
        if (menu === 'settings') {
          await editProfiles(terminal,loadProfiles(env),loaded,env); continue;
        }
        let state;
        const resuming = menu === 'resume';
        if (resuming) {
          state = saved;
          const guidance = await terminal.ask(`Resume ${state.workflow.name}\n${state.reason ?? ''}\nAdd guidance, or leave blank to resume`);
          if (guidance === null) continue;
          if (guidance) { state.guidance.push({node:state.current,text:guidance});store.save(state); }
        } else {
          let workflow;
          if (menu === 'goal') {
            const objective = await terminal.ask('What goal should aio work toward?');
            if (!objective) continue;
            const criteria = await collectCriteria(terminal);
            if (!criteria) continue;
            workflow = standaloneGoal(objective,criteria);
          } else {
            const workflows = listWorkflows(root);
            if (!workflows.length) { await terminal.message('No project workflows',`Place version 2 YAML workflows in ${path.join(root,'.aio/workflows')}`); continue; }
            const file = await terminal.choose('Choose a workflow',workflows.map(w=>({label:w.name,value:w.file})));
            if (!file) continue;
            workflow = readWorkflow(file);
          }
          const profiles = loadProfiles(env);
          if (Object.values(workflow.nodes).some(n=>['action','route'].includes(n.type)) && !Object.keys(profiles.profiles).length) {
            if (!await setupProfiles(terminal,profiles,loaded,env)) continue;
          }
          let launch = false;
          for (;;) {
            const choice = await terminal.choose(`Ready: ${workflow.name}\nChanges here apply to this session.`, [
              ...Object.entries(workflow.nodes).map(([id,n],i)=>({label:`${i+1}. ${n.name ?? id} · ${n.type}${n.modelProfile ? ' · '+n.modelProfile : ''}`,value:id})),
              null,{label:'Launch workflow',value:'$launch'},{label:'Cancel',value:'$cancel'},
            ]);
            if (!choice || choice === '$cancel') break;
            if (choice === '$launch') { launch = true; break; }
            const node = workflow.nodes[choice];
            if (!node.modelProfile) { await terminal.message(node.name ?? choice,JSON.stringify(node,null,2)); continue; }
            const selected = await terminal.choose(`Profile for ${node.name ?? choice}`,Object.entries(profiles.profiles).map(([name,list])=>({label:`${name}: ${list.map(v=>v.harness+'/'+v.model).join(' → ')}`,value:name})));
            if (selected) node.modelProfile = selected;
          }
          if (!launch) continue;
          const snapshot = snapshotProfiles(workflow,profiles.profiles,loaded);
          state = store.start(workflow,snapshot);
        }
        const bus = new EventEmitter(), detach = store.attach(bus);
        const view = attachWorkflowView(bus,{state,output,terminal});
        const notifications = attachNotifications(bus,{config:loaded.config.notifications,state,projectRoot:root,env});
        let pause = false;
        const key = (text) => { if (text === 'q') quit(); if (text === 'p') pause = true; };
        let event = resuming ? 'resumed' : 'started';
        try {
          while (!controller.signal.aborted) {
            pause = false; terminal.on('key',key); view.start(); bus.emit(event); event = 'resumed';
            try { await runUntilPause({root,state,store,env,bus,signal:controller.signal,pauseRequested:()=>pause}); }
            finally { await notifications.flush(); view.stop(); terminal.off('key',key); }
            if (controller.signal.aborted) break;
            if (state.status === 'done') {
              const results = Object.entries(state.results).flatMap(([id,report])=>[
                `${state.workflow.nodes[id].name ?? id}: ${report.summary}`,
                ...(report.criteria ?? []).map((c,i)=>`${state.workflow.nodes[id].criteria[i]}: ${c.status} — ${c.evidence}`),
              ]);
              await terminal.message('Workflow complete',results.join('\n')); break;
            }
            const action = await terminal.choose(`Paused\n${state.reason}`, [{label:'Resume with guidance',value:'resume'},{label:'Back to menu',value:'menu'},{label:'Quit',value:'quit'}]);
            if (action === 'quit') { quit(); break; }
            if (action !== 'resume') break;
            const guidance = await terminal.ask('Add guidance, or leave blank to resume');
            if (guidance === null) break;
            if (guidance) { state.guidance.push({node:state.current,text:guidance});store.save(state); }
          }
        } finally { await notifications.close(); view.close(); detach(); }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        await terminal.message('Cannot continue',error.message);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted || error.name !== 'AbortError') throw error;
  } finally {
    terminal.close(); store?.close();
    for (const signal of signals) process.off(signal,quit);
    input.off('end',quit); input.off('close',quit); output.off('error',quit);
  }
  return {status:'closed'};
}
module.exports = { runInteractive };
