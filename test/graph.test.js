const test = require('node:test');
const assert = require('node:assert/strict');
const { standaloneGoal, validateWorkflow } = require('../lib/graph');
test('Goal creates separate action and criterion routing with a correction cycle', () => {
  const graph = standaloneGoal('Create file', ['File exists']);
  assert.equal(graph.version, 2);
  assert.equal(graph.nodes.action.modelProfile, 'mid');
  assert.equal(graph.nodes.validation.modelProfile, 'low');
  assert.equal(graph.nodes.action.criteria, undefined);
  assert.deepEqual(graph.nodes.validation.criteria, ['File exists']);
  assert.deepEqual(graph.nodes.validation.routes.map(r => r.to), ['action', 'end']);
});
test('version 2 rejects legacy and malformed graphs', () => {
  const cases = [
    [g => delete g.version, /Incompatible/],
    [g => g.nodes.action.type = 'goal', /Unknown node/],
    [g => g.nodes.action.next = 'missing', /Unknown destination/],
    [g => g.nodes.action.next = 'action', /no path/],
    [g => g.nodes.validation.criteria = [], /criteria/],
    [g => g.maxInvocations = 0, /positive/],
    [g => g.nodes.action.model = 'direct', /Unknown/],
  ];
  for (const [change, pattern] of cases) {
    const graph = standaloneGoal('Work', ['Done']); change(graph);
    assert.throws(() => validateWorkflow(graph), pattern);
  }
});
test('scripts choose exactly one fixed or routed successor', () => {
  const graph = standaloneGoal('Work', ['Done']);
  graph.nodes.action = { type: 'script', command: 'node', args: ['check.js'], next: 'validation' };
  validateWorkflow(graph);
  graph.nodes.action.routes = [{ to: 'end', description: 'Pass' }];
  assert.throws(() => validateWorkflow(graph), /exactly one/);
  delete graph.nodes.action.next;
  validateWorkflow(graph);
  graph.nodes.action.timeoutMs = -1;
  assert.throws(() => validateWorkflow(graph), /timeout/);
});
