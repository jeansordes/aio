const test=require('node:test');
const assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Terminal}=require('../lib/terminal');
const {editProfiles,collectCriteria,setupProfiles}=require('../lib/interactive-settings');
const {loadProfiles,saveProfiles}=require('../lib/model-profiles');
function scripted(choices,answers=[]) {
  return {choose:async(title,entries)=>{const value=choices.shift();assert.ok(value===null||entries.some(e=>e?.value===value),`Invalid choice ${value} for ${title}`);return value;},ask:async()=>answers.shift(),message:async()=>{}};
}
test('profile editor persists reorder, change, rename, removal and creation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aio-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profiles=loadProfiles({XDG_CONFIG_HOME:root});profiles.profiles.low=[{harness:'fixture',model:'a'},{harness:'fixture',model:'b'}];saveProfiles(profiles);
  const loaded={harnesses:{fixture:{command:process.execPath}}};
  await editProfiles(scripted(['low',1,'up',0,'edit','fixture','rename',1,'remove','back','+','fixture','back','<'],['new-model','review','new-profile','other-model']),profiles,loaded,process.env);
  assert.deepEqual(loadProfiles({XDG_CONFIG_HOME:root}).profiles,{review:[{harness:'fixture',model:'new-model'}],'new-profile':[{harness:'fixture',model:'other-model'}]});
});
test('criteria editor permits literal shortcuts, edits and deletion before finishing',async()=>{
  const terminal=scripted(['add',0,'edit','add',0,'delete','finish'],['q','updated','actual criterion']);
  assert.deepEqual(await collectCriteria(terminal),['actual criterion']);
});
test('initial profiles use explicit identifiers for all three tiers',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aio-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profiles=loadProfiles({XDG_CONFIG_HOME:root});
  assert.equal(await setupProfiles(scripted(['fixture','fixture','fixture'],['small-id','middle-id','large-id']),profiles,{harnesses:{fixture:{command:process.execPath}}},process.env),true);
  assert.deepEqual(Object.keys(profiles.profiles),['low','mid','high']);
  assert.equal(profiles.profiles.high[0].model,'large-id');
});
test('raw terminal handles arrows, literal text, cancellation and restores cursor',async()=>{
  const input=new PassThrough(),output=new PassThrough();let content='';output.on('data',c=>content+=c);
  output.isTTY=true;output.columns=25;output.rows=8;let raw=false;input.setRawMode=value=>{raw=value;};
  const controller=new AbortController(),terminal=new Terminal(input,output,controller.signal);
  try {
    const select=terminal.choose('Menu',[{label:'One',value:1},null,{label:'Two',value:2}]);
    input.write('\x1b[B\r');assert.equal(await select,2);
    const answer=terminal.ask('Text');input.write('q\r');assert.equal(await answer,'q');
    const waiting=terminal.ask('Cancelled');controller.abort();await assert.rejects(waiting,{name:'AbortError'});
  } finally {terminal.close();}
  assert.equal(raw,false);assert.match(content,/\x1b\[\?25h/);assert.equal(input.listenerCount('keypress'),0);
});
