import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOccurrence, consumeAgentOccurrence } from '../src/agentInvocation.ts';
import { createPlaybookState, processNextStep, completeSubAgent } from '../../../pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts';

const node = (id, category, subtype, config = {}) => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { label: id, category, subtype, config } });
const edge = (source, target, sourceHandle, targetHandle) => ({ id: `${source}-${target}`, source, target, sourceHandle, targetHandle });

test('loop body gets new invocation while restart before consumption reuses occurrence', () => {
  let state = createPlaybookState({ id: 'qa', name: 'qa', nodes: [node('start', 'trigger', 'manual'), node('loop', 'flow', 'loop', { maxIterations: 2 }), node('agent', 'agent', 'agent', { agentId: 'qa', prompt: 'qa' }), node('end', 'flow', 'merge')], edges: [edge('start', 'loop', undefined, 'loop-entry'), edge('loop', 'agent', 'loop-start'), edge('agent', 'loop', undefined, 'loop-back'), edge('loop', 'end', 'loop-exit')] }, 'synthetic');
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const step = processNextStep(state);
    if (step.action === 'spawn_sub_agent') {
      const occurrence = agentOccurrence(state, step.nodeId);
      assert.equal(agentOccurrence(JSON.parse(JSON.stringify(state)), step.nodeId), occurrence);
      seen.push(occurrence);
      state = consumeAgentOccurrence(completeSubAgent(state, step.nodeId, `answer ${occurrence}`).updatedPlaybook, step.nodeId);
      state = JSON.parse(JSON.stringify(state));
    } else if (step.action === 'node_completed') state = step.updatedPlaybook;
    else if (step.action === 'workflow_completed') break;
    else assert.fail(`Unexpected step: ${step.action}`);
  }
  assert.deepEqual(seen, [0, 1]);
});

test('a consumed decision attempt advances independently of completed node IDs', () => {
  const pending = { agentInvocationCounts: {}, pendingDecision: { nodeId: 'decision', prompt: 'choose' } };
  const saved = JSON.parse(JSON.stringify(pending));
  assert.equal(agentOccurrence(saved, 'decision'), 0);
  const retry = consumeAgentOccurrence(saved, 'decision');
  assert.equal(agentOccurrence(JSON.parse(JSON.stringify(retry)), 'decision'), 1);
  assert.equal(agentOccurrence(pending, 'decision'), 0);
});

test('partial parallel checkpoint resumes only the unconsumed sibling', () => {
  let state = createPlaybookState({id:'parallel-qa',name:'parallel-qa',nodes:[node('start','trigger','manual'),node('fork','flow','parallel'),node('a','agent','agent',{agentId:'qa',prompt:'a'}),node('b','agent','agent',{agentId:'qa',prompt:'b'})],edges:[edge('start','fork'),edge('fork','a'),edge('fork','b')]}, 'synthetic');
  state = processNextStep(state).updatedPlaybook;
  const parallel = processNextStep(state);
  assert.equal(parallel.action, 'spawn_parallel_agents');
  assert.equal(parallel.nodes.length, 2);
  state = consumeAgentOccurrence(completeSubAgent(state, 'a', 'answer a').updatedPlaybook, 'a');
  const restored = JSON.parse(JSON.stringify(state));
  const next = processNextStep(restored);
  assert.equal(next.action, 'spawn_sub_agent');
  assert.equal(next.nodeId, 'b');
  assert.equal(agentOccurrence(restored, 'a'), 1);
  assert.equal(agentOccurrence(restored, 'b'), 0);
});
