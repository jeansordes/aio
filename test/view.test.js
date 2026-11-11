const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {renderGraph,attachWorkflowView}=require('../lib/workflow-view');
const {standaloneGoal}=require('../lib/graph');
test('numbered graph separates execution and selection, retains back edges and wraps',()=>{
  const state={workflow:standaloneGoal('Very long objective',['Done']),current:'validation',status:'running',results:{action:{decision:'done'}}};
  const graph=renderGraph(state,80,'action').join('\n');
  assert.match(graph,/>\[1\]</);assert.match(graph,/\*  \[2\]  → \[1\], \[3\]/);
  assert.doesNotMatch(graph,/objective|validation|Done/);
  assert.ok(renderGraph(state,5).every(line=>Array.from(line).length<5));
  assert.notDeepEqual(renderGraph(state,80,'action',0,true),renderGraph(state,80,'action',1,true));
});
test('inspection follows keyboard without changing execution and shows only selected details',()=>{
  const state={workflow:standaloneGoal('Work prompt',['Criterion secret']),current:'action',status:'running',results:{},history:[],modelConfig:{profiles:{mid:[],low:[]}}};
  const bus=new EventEmitter(),terminal=new EventEmitter();let screen='';terminal.screen=lines=>{screen=lines.join('\n');};
  const output={isTTY:true,columns:80,rows:40,write(){}};
  const view=attachWorkflowView(bus,{state,output,terminal});view.start();
  try {
    assert.match(screen,/Work prompt/);
    terminal.emit('key','',{name:'right'});assert.match(screen,/Validation \(route\)/);
    assert.equal(state.current,'action');assert.doesNotMatch(screen,/Work prompt/);
    terminal.emit('key','f',{});assert.match(screen,/Work prompt/);
    output.columns=15;output.rows=8;terminal.redraw();
    assert.match(screen,/Work/); assert.match(screen,/>\[1\]</);
  } finally {view.close();}
  assert.equal(bus.listenerCount('nodeEnter'),0);
});
