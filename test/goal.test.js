const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const cli = require.resolve('../lib/cli');
function project(t, mode = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'aio-ui-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'global/aio'),{recursive:true});
  fs.writeFileSync(path.join(root,'agent.cjs'),String.raw`
    const fs=require('node:fs'),prompt=process.argv.at(-1);
    const target=JSON.parse(prompt.match(/report to (".*") \(relative/)[1]);
    const state=JSON.parse(fs.readFileSync(JSON.parse(prompt.match(/reading at (".*")\./)[1])));
    const node=state.workflow.nodes[state.current];
    let report=node.type==='action'?{decision:'done',summary:'Work produced'}:{decision:'route',to:'end',summary:'Verified independently',criteria:[{status:'satisfied',evidence:'Observed expected file'}]};
    if(process.env.UI_MODE==='block'&&!state.guidance.length)report={decision:'blocked',summary:'Checked',request:'Which fixture?'};
    fs.writeFileSync(target,JSON.stringify(report));
  `);
  fs.writeFileSync(path.join(root,'global/aio/config.yaml'),YAML.stringify({harnesses:{fixture:{command:process.execPath,args:['agent.cjs','{{model}}','{{prompt}}']}}}));
  fs.writeFileSync(path.join(root,'global/aio/model-profiles.yaml'),YAML.stringify({profiles:Object.fromEntries(['low','mid','high'].map(n=>[n,[{harness:'fixture',model:n}]]))}));
  return {root,mode};
}
function open(t,{root,mode}) {
  const child=spawn(process.execPath,['-e',`require(${JSON.stringify(cli)}).routeCommand([], {stdinIsTTY:true,stdoutIsTTY:true}).catch(e=>{console.error(e);process.exitCode=1})`],{cwd:root,env:{...process.env,UI_MODE:mode,XDG_CONFIG_HOME:path.join(root,'global')}});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='',cursor=0,closed=false;
  child.stdout.setEncoding('utf8').on('data',c=>output+=c);child.stderr.setEncoding('utf8').on('data',c=>output+=c);
  const exit=new Promise(resolve=>child.on('close',code=>{closed=true;resolve(code);}));
  async function see(value) {
    const deadline=Date.now()+5000;
    while(true){const at=output.indexOf(value,cursor);if(at>=0){cursor=at+value.length;return;}
      assert.ok(Date.now()<deadline&&!closed,`Expected ${value} in ${output}`);await new Promise(r=>setTimeout(r,10));}
  }
  return {see,keys:value=>child.stdin.write(value),type:value=>child.stdin.write(value+'\r'),exit:async()=>assert.equal(await exit,0,output)};
}
async function enterGoal(app, criterion='File exists') {
  await app.see('aio — Workflows and Goals');app.keys('\x1b[B\r');
  await app.see('What goal should aio work toward?');app.type('Create a file');
  await app.see('Success criteria');app.keys('\r');
  await app.see('New success criterion');app.type(criterion);
  await app.see('Finish criteria');app.keys('\x1b[B\x1b[B\r');
  await app.see('Launch workflow');app.keys('\x1b[B\x1b[B\x1b[B\r');
}
const readState=p=>JSON.parse(fs.readFileSync(path.join(p.root,'.aio/sessions/current/session.json')));
test('keyboard Goal collects q as literal text and completes through independent validation', {timeout:12000},async t=>{
  const p=project(t),app=open(t,p);await enterGoal(app,'q');
  await app.see('Workflow complete');app.keys('\r');await app.see('aio — Workflows and Goals');app.keys('q');await app.exit();
  const state=readState(p);assert.equal(state.status,'done');assert.deepEqual(state.workflow.nodes.validation.criteria,['q']);
  assert.deepEqual(state.history.map(h=>h.node),['action','validation']);
});
test('blocked execution returns to menu and resumes with persisted guidance', {timeout:12000},async t=>{
  const p=project(t,'block'),app=open(t,p);await enterGoal(app);
  await app.see('Your input is needed: Which fixture?');app.keys('\x1b[B\r');
  await app.see('Resume — Goal');app.keys('\x1b[B\x1b[B\r');
  await app.see('Add guidance, or leave blank to resume');app.type('Use local fixture');
  await app.see('Workflow complete');app.keys('\r');await app.see('aio — Workflows and Goals');app.keys('q');await app.exit();
  assert.equal(readState(p).status,'done');assert.equal(readState(p).guidance[0].text,'Use local fixture');
});
test('empty workflow directory and old sessions keep menu available', {timeout:12000},async t=>{
  const p=project(t);fs.mkdirSync(path.join(p.root,'.aio/sessions/current'),{recursive:true});
  fs.writeFileSync(path.join(p.root,'.aio/sessions/current/session.json'),JSON.stringify({version:1}));
  const app=open(t,p);await app.see('Old session format');app.keys('\r');
  await app.see('No project workflows');app.keys('\r');await app.see('aio — Workflows and Goals');app.keys('q');await app.exit();
  assert.equal(readState(p).version,1);
});
test('project script workflow is selectable without model setup', {timeout:12000},async t=>{
  const p=project(t);fs.unlinkSync(path.join(p.root,'global/aio/model-profiles.yaml'));
  fs.mkdirSync(path.join(p.root,'.aio/workflows'),{recursive:true});
  fs.writeFileSync(path.join(p.root,'.aio/workflows/script.yaml'),YAML.stringify({version:2,name:'Script demo',initial:'run',nodes:{run:{type:'script',command:process.execPath,args:['-e','console.log("script ran")'],next:'end'},end:{type:'end'}}}));
  const app=open(t,p);await app.see('aio — Workflows and Goals');app.keys('\r');await app.see('Choose a workflow');app.keys('\r');
  await app.see('Launch workflow');app.keys('\x1b[B\x1b[B\r');await app.see('Workflow complete');app.keys('\r');
  await app.see('aio — Workflows and Goals');app.keys('q');await app.exit();assert.equal(readState(p).status,'done');
});
