const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { openSession } = require('../lib/session');
const { standaloneGoal } = require('../lib/graph');
const { runUntilPause, validateReport } = require('../lib/runtime');
function fixture(t, workflow = standaloneGoal('Build', ['Works'])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-runtime-'));
  const store = openSession(root), bus = new EventEmitter(), detach = store.attach(bus);
  t.after(() => { detach(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'agent.cjs'), String.raw`
    const fs = require('node:fs');
    const prompt = process.argv.at(-1);
    const target = JSON.parse(prompt.match(/report to (".*") \(relative/)[1]);
    const sessionPath = JSON.parse(prompt.match(/reading at (".*")\./)[1]);
    const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    fs.appendFileSync('prompts.jsonl', JSON.stringify({prompt, model: process.argv[2]})+'\n');
    let report = {decision:'done', summary:'Implemented'};
    const node = state.workflow.nodes[state.current];
    if (node.type === 'route') {
      const pass = process.env.MODE !== 'cycle' && (process.env.MODE !== 'correct' || state.history.filter(h=>h.node==='action').length >= 2);
      report = {decision:'route', to:pass?'end':'action', summary:pass?'Verified':'Needs correction', criteria:[{status:pass?'satisfied':'not_satisfied', evidence:'Checked file'}]};
    }
    if (process.env.MODE === 'block' && !state.guidance.length) report = {decision:'blocked',summary:'Need data',request:'Provide fixture'};
    if (process.env.MODE === 'invalid') report = {decision:'continue',summary:'Invalid action'};
    if (process.env.MODE === 'quota' && process.argv[2] === 'first') {
      fs.writeFileSync('partial.txt','preserve me'); console.error('quota exhausted'); process.exit(1);
    }
    if (process.env.MODE === 'unknown') {console.error('permission denied');process.exit(1);}
    if (process.env.MODE === 'zero-quota' && process.argv[2] === 'first') {console.log(JSON.stringify({type:'turn.failed',error:{message:'quota exhausted'}}));process.exit(0);}
    if (process.env.MODE === 'stdout-quota') {console.log(JSON.stringify({type:'error',message:'rate_limit_exceeded'}));process.exit(1);}
    fs.writeFileSync(target,JSON.stringify(report));
    if (process.env.MODE === 'hang') {
      require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      console.log('ready-to-interrupt');setInterval(()=>{},1000);
    }
  `);
  const modelConfig = { profiles: {}, harnesses: { fixture: { command: process.execPath, args:['agent.cjs','{{model}}','{{prompt}}'] } } };
  for (const name of ['mid','low']) modelConfig.profiles[name] = [{harness:'fixture',model:'first'},{harness:'fixture',model:'second'}];
  const state = store.start(workflow, modelConfig);
  const run = (mode='', extra={}) => runUntilPause({root,store,state,bus,env:{...process.env,MODE:mode},signal:new AbortController().signal,...extra});
  return {root,store,state,bus,run};
}
test('independent validation corrects then finishes; snapshots and visits survive resume', async t => {
  const f=fixture(t);
  await f.run('correct',{pauseRequested:()=>true});
  assert.equal(f.state.current,'validation');
  assert.equal(f.store.load().version,2);
  await f.run('correct');
  assert.equal(f.state.status,'done');
  assert.deepEqual(f.state.history.map(h=>h.node),['action','validation','action','validation']);
  assert.deepEqual(f.state.history.map(h=>h.visit),[1,2,3,4]);
  const prompts=fs.readFileSync(path.join(f.root,'prompts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.match(prompts[2].prompt,/Needs correction/);
});
test('criteria require evidence and all must pass before ending', () => {
  const workflow=standaloneGoal('Build',['Works']), node=workflow.nodes.validation;
  for (const criteria of [[],[{status:'not_satisfied',evidence:'Fail'}],[{status:'indeterminate',evidence:'Unknown'}]]) {
    assert.throws(()=>validateReport({decision:'route',to:'end',summary:'why',criteria},node,workflow));
  }
  assert.throws(()=>validateReport({decision:'route',to:'missing',summary:'why'},node,workflow),/allowed/);
  assert.equal(validateReport({decision:'blocked',summary:'Unknown',request:'Provide fixture'},node,workflow).decision,'blocked');
});
test('blocks and global bounds pause; explicit resume opens a new window', async t => {
  const graph=standaloneGoal('Work',['Done']);graph.maxInvocations=3;
  const f=fixture(t,graph);
  await f.run('block');assert.match(f.state.reason,/Provide fixture/);
  f.state.guidance.push({node:'action',text:'Here'});
  await f.run('cycle');assert.match(f.state.reason,/Invocation limit/);
  await f.run();assert.equal(f.state.status,'done');
});
test('quota fallback preserves partial work, records selection, and excludes failed pairs for this window', async t => {
  const f=fixture(t);const attempts=[];f.bus.on('modelSelected',v=>attempts.push(v.model));
  await f.run('quota');
  assert.equal(f.state.status,'done');
  assert.deepEqual(attempts,['first','second','second']);
  assert.equal(fs.readFileSync(path.join(f.root,'partial.txt'),'utf8'),'preserve me');
  assert.equal(f.state.history[0].selection.index,2);
  assert.match(fs.readFileSync(path.join(f.root,'prompts.jsonl'),'utf8'),/Inspect actual project state/);
});
test('missing executable falls back; all unavailable and structured quota failures pause', async t => {
  const f=fixture(t);
  f.state.modelConfig.harnesses.missing={command:'/definitely/not/a/command',args:['{{model}}','{{prompt}}']};
  f.state.modelConfig.profiles.mid.unshift({harness:'missing',model:'first'});
  await f.run('stdout-quota');assert.match(f.state.reason,/No available model/);
  await f.run();assert.equal(f.state.status,'done');
});
test('fallback attempts count against the cap and unknown errors do not fall back', async t => {
  const graph=standaloneGoal('Build',['Works']);graph.maxInvocations=1;
  const f=fixture(t,graph);await f.run('quota');assert.match(f.state.reason,/Invocation limit/);
  assert.equal(f.state.history.length,0);
  await f.run('unknown');assert.match(f.state.reason,/permission denied/);
  await f.run('invalid');assert.match(f.state.reason,/action must/);
  assert.equal(f.state.history.length,0);
});
test('interrupt stops child group and rejects a written report', {timeout:8000}, async t => {
  const f=fixture(t),controller=new AbortController();
  f.bus.on('providerStdout',({chunk})=>{if(chunk.includes('ready-to-interrupt'))controller.abort();});
  await f.run('hang',{signal:controller.signal});
  assert.equal(f.state.interrupted,true);assert.equal(f.state.history.length,0);
  assert.equal(f.store.load().inFlight,false);
  await f.run();assert.equal(f.state.status,'done');
});
test('script action and script route run without a shell', async t => {
  const graph={version:2,name:'Scripts',initial:'write',nodes:{
    write:{type:'script',command:process.execPath,args:['-e',"require('fs').writeFileSync('literal.txt',process.argv[1])",'$(should-not-run)'],next:'choose'},
    choose:{type:'script',command:process.execPath,args:['-e',"console.log(JSON.stringify({to:'end',summary:'Verified'}))"],routes:[{to:'end',description:'Pass'}]},end:{type:'end'}}};
  const f=fixture(t,graph);await f.run();assert.equal(f.state.status,'done');
  assert.equal(fs.readFileSync(path.join(f.root,'literal.txt'),'utf8'),'$(should-not-run)');
});
test('script errors, invalid JSON, destinations and deadlines pause', async t => {
  for (const [code,pattern] of [["console.error('broken');process.exit(2)",/exited with 2/],["console.log('not json')",/Invocation failed/],["console.log(JSON.stringify({to:'unknown',summary:'Bad'}))",/allowed destination/],["setInterval(()=>{},1000)",/timed out/]]) {
    const graph={version:2,name:'Script',initial:'run',nodes:{run:{type:'script',command:process.execPath,args:['-e',code],timeoutMs:150,routes:[{to:'end',description:'Pass'}]},end:{type:'end'}}};
    const f=fixture(t,graph);await f.run();assert.equal(f.state.status,'paused');assert.match(f.state.reason,pattern);assert.equal(f.state.history.length,0);
  }
});
test('session locking, crash recovery and incompatible archives preserve old data', t => {
  const f=fixture(t);assert.throws(()=>openSession(f.root),/locked/);
  f.state.inFlight=true;f.store.save(f.state);assert.equal(f.store.load().interrupted,true);
  fs.writeFileSync(f.store.file,JSON.stringify({version:1,special:'old data'}));
  assert.equal(f.store.load().incompatible,true);
  f.store.start(standaloneGoal('New',['Done']),f.state.modelConfig);
  const base=path.dirname(f.store.dir),archive=fs.readdirSync(base).find(n=>n.startsWith('archive-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(base,archive,'session.json'))).special,'old data');
});

test('structured quota failure with exit zero still falls back', async t => {
  const f=fixture(t);await f.run('zero-quota');
  assert.equal(f.state.status,'done');assert.equal(f.state.history[0].selection.model,'second');
});
