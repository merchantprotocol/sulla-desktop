import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  completeSubAgent,
  processNextStep,
  resolveDecision,
  type PlaybookStepResult,
} from '../../../pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.js';
import type { WorkflowPlaybookState } from '../../../pkg/rancher-desktop/agent/workflow/types.js';

import { config } from './config.js';
import { closeDb, pool } from './db.js';
import { closeEvents, emitEvent } from './events.js';
import { OnDemandRuntimeLauncher } from './runtime.js';
import { DesktopAgentLauncher, ScopedToolClient } from './toolClient.js';

const executionId = process.env.SULLA_EXECUTION_ID ?? '';
const runToken = process.env.SULLA_RUN_TOKEN ?? '';
const ownerId = `runner-${ process.pid }-${ crypto.randomBytes(4).toString('hex') }`;
const tools = new ScopedToolClient(runToken);
const agents = new DesktopAgentLauncher(tools);
const runtimes = new OnDemandRuntimeLauncher();

function node(playbook: WorkflowPlaybookState, nodeId: string): any {
  return playbook.definition.nodes.find(candidate => candidate.id === nodeId);
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function persistState(playbook: WorkflowPlaybookState): Promise<void> {
  await pool.query(
    `UPDATE workflow_executions SET playbook_state=$2::jsonb, updated_at=NOW()
     WHERE execution_id=$1 AND owner_id=$3`,
    [executionId, JSON.stringify(playbook), ownerId],
  );
}

async function checkpoint(playbook: WorkflowPlaybookState, nodeId: string, result: unknown): Promise<void> {
  const current = node(playbook, nodeId);
  await pool.query(
    `INSERT INTO workflow_checkpoints
       (execution_id, workflow_id, workflow_name, node_id, node_label, node_subtype,
        sequence, playbook_state, node_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [executionId, playbook.workflowId, playbook.definition.name, nodeId,
      current?.data?.label ?? nodeId, current?.data?.subtype ?? 'unknown',
      Object.keys(playbook.nodeOutputs ?? {}).length, JSON.stringify(playbook), JSON.stringify(result ?? null)],
  );
  await persistState(playbook);
}

async function completeNode(playbook: WorkflowPlaybookState, nodeId: string, result: unknown, threadId?: string): Promise<WorkflowPlaybookState> {
  const completed = completeSubAgent(playbook, nodeId, result, threadId);
  const next = completed.updatedPlaybook;
  await emitEvent(executionId, next.workflowId, 'node_completed', {
    nodeLabel: node(next, nodeId)?.data?.label ?? nodeId,
    output: result,
  }, nodeId);
  await checkpoint(next, nodeId, result);
  return next;
}

async function callAgent(playbook: WorkflowPlaybookState, nodeId: string, agentId: string, prompt: string): Promise<WorkflowPlaybookState> {
  const label = node(playbook, nodeId)?.data?.label ?? nodeId;
  await emitEvent(executionId, playbook.workflowId, 'node_started', { nodeLabel: label }, nodeId);
  const result = await agents.run(agentId || 'sulla-desktop', prompt, label);
  return completeNode(playbook, nodeId, result.output, result.threadId);
}

async function waitForChild(childExecutionId: string): Promise<unknown> {
  const deadline = Date.now() + 24 * 60 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${ config.managerUrl }/v1/runs/${ encodeURIComponent(childExecutionId) }`);
    if (!response.ok) throw new Error(`Child run ${ childExecutionId } lookup failed (${ response.status })`);
    const run: any = await response.json();
    if (run.status === 'completed') {
      const state = run.playbook_state as WorkflowPlaybookState;
      const finalNodeId = state.completedNodeIds[state.completedNodeIds.length - 1];
      return state.nodeOutputs?.[finalNodeId]?.result ?? null;
    }
    if (run.status === 'failed') throw new Error(`Child run ${ childExecutionId } failed: ${ run.error ?? 'unknown error' }`);
    if (run.status === 'suspended' && run.wait_kind === 'user-input') throw new Error(`Child run ${ childExecutionId } requires user input`);
    await delay(1_000);
  }
  throw new Error(`Child run ${ childExecutionId } exceeded the 24 hour parent wait limit`);
}

async function startChild(workflowId: string, payload: unknown): Promise<{ executionId: string }> {
  const response = await fetch(`${ config.managerUrl }/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ runToken }` },
    body: JSON.stringify({ workflowId, message: outputText(payload), parentExecutionId: executionId }),
  });
  const json: any = await response.json();
  if (!response.ok) throw new Error(json.error ?? `Could not start child workflow (${ response.status })`);
  return json;
}

async function suspend(playbook: WorkflowPlaybookState, kind: string, payload: unknown, resumeAt?: Date): Promise<void> {
  await pool.query(
    `UPDATE workflow_executions
       SET status='suspended', playbook_state=$2::jsonb, wait_kind=$3, wait_payload=$4::jsonb,
           resume_at=$5, owner_id=NULL, lease_token=NULL, lease_expires_at=NULL, runner_id=NULL, updated_at=NOW()
     WHERE execution_id=$1 AND owner_id=$6`,
    [executionId, JSON.stringify(playbook), kind, JSON.stringify(payload ?? null), resumeAt?.toISOString() ?? null, ownerId],
  );
  await emitEvent(executionId, playbook.workflowId, 'workflow_waiting', { waitKind: kind, resumeAt: resumeAt?.toISOString(), payload });
}

async function settle(playbook: WorkflowPlaybookState, status: 'completed' | 'failed', error?: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_executions
       SET status=$2, playbook_state=$3::jsonb, error=$4, completed_at=NOW(), terminal_at=NOW(),
           owner_id=NULL, lease_token=NULL, lease_expires_at=NULL, runner_id=NULL, updated_at=NOW()
     WHERE execution_id=$1 AND owner_id=$5`,
    [executionId, status, JSON.stringify(playbook), error ?? null, ownerId],
  );
  await emitEvent(executionId, playbook.workflowId, status === 'completed' ? 'workflow_completed' : 'workflow_failed', error ? { error } : {});
}

async function executeStep(playbook: WorkflowPlaybookState, step: PlaybookStepResult): Promise<{ playbook: WorkflowPlaybookState; exit?: boolean }> {
  switch (step.action) {
  case 'node_completed': {
    await emitEvent(executionId, playbook.workflowId, 'node_started', { nodeLabel: node(playbook, step.nodeId)?.data?.label ?? step.nodeId }, step.nodeId);
    await emitEvent(executionId, step.updatedPlaybook.workflowId, 'node_completed', { output: step.result }, step.nodeId);
    await checkpoint(step.updatedPlaybook, step.nodeId, step.result);
    return { playbook: step.updatedPlaybook };
  }
  case 'execute_tool_call': {
    await emitEvent(executionId, playbook.workflowId, 'node_started', { toolName: step.toolName }, step.nodeId);
    const result = await tools.call(step.toolName, step.params);
    return { playbook: await completeNode(playbook, step.nodeId, result) };
  }
  case 'execute_function': {
    await emitEvent(executionId, playbook.workflowId, 'node_started', { functionRef: step.functionRef }, step.nodeId);
    const result = await runtimes.run(step.functionRef, step.inputs);
    return { playbook: await completeNode(playbook, step.nodeId, result) };
  }
  case 'spawn_sub_agent':
    return { playbook: await callAgent(playbook, step.nodeId, step.agentId, step.prompt) };
  case 'spawn_parallel_agents': {
    const results = await Promise.all(step.nodes.map(item => agents.run(item.agentId, item.prompt, node(playbook, item.nodeId)?.data?.label ?? item.nodeId)));
    let next = playbook;
    for (let index = 0; index < step.nodes.length; index++) next = await completeNode(next, step.nodes[index].nodeId, results[index].output, results[index].threadId);
    return { playbook: next };
  }
  case 'prompt_agent': {
    const pendingNodeId = step.updatedPlaybook.pendingDecision?.nodeId;
    if (!pendingNodeId) throw new Error('Prompt action has no pending decision node');
    await emitEvent(executionId, playbook.workflowId, 'node_started', { nodeLabel: node(playbook, pendingNodeId)?.data?.label ?? pendingNodeId }, pendingNodeId);
    const result = await agents.run('sulla-desktop', step.prompt, `workflow-${ pendingNodeId }`);
    const resolved = resolveDecision(step.updatedPlaybook, outputText(result.output));
    await emitEvent(executionId, playbook.workflowId, 'node_completed', { output: result.output }, pendingNodeId);
    await checkpoint(resolved.updatedPlaybook, pendingNodeId, result.output);
    return { playbook: resolved.updatedPlaybook };
  }
  case 'prompt_orchestrator': {
    const result = await agents.run('sulla-desktop', step.prompt, `workflow-${ step.nodeId }`);
    return { playbook: await completeNode(playbook, step.nodeId, result.output, result.threadId) };
  }
  case 'spawn_sub_workflow': {
    const child = await startChild(step.workflowId, step.payload);
    return { playbook: await completeNode(playbook, step.nodeId, await waitForChild(child.executionId)) };
  }
  case 'transfer_workflow': {
    const child = await startChild(step.targetWorkflowId, step.payload);
    const next = await completeNode(playbook, step.nodeId, { transferredTo: child.executionId });
    await settle(next, 'completed');
    return { playbook: next, exit: true };
  }
  case 'wait': {
    await emitEvent(executionId, playbook.workflowId, 'node_started', { nodeLabel: node(playbook, step.nodeId)?.data?.label ?? step.nodeId }, step.nodeId);
    const resumeAt = new Date(Date.now() + Math.max(0, step.durationMs));
    const next = completeSubAgent(playbook, step.nodeId, `Wait completed at ${ resumeAt.toISOString() }`).updatedPlaybook;
    await checkpoint(next, step.nodeId, { resumeAt: resumeAt.toISOString() });
    await suspend(next, 'timer', { nodeId: step.nodeId }, resumeAt);
    return { playbook: next, exit: true };
  }
  case 'await_user_input':
    await emitEvent(executionId, playbook.workflowId, 'node_started', { nodeLabel: node(playbook, step.nodeId)?.data?.label ?? step.nodeId }, step.nodeId);
    await emitEvent(executionId, playbook.workflowId, 'node_waiting', { promptText: step.promptText }, step.nodeId);
    await suspend(step.updatedPlaybook, 'user-input', { nodeId: step.nodeId, promptText: step.promptText });
    return { playbook: step.updatedPlaybook, exit: true };
  case 'workflow_completed':
    await settle(step.updatedPlaybook, 'completed');
    return { playbook: step.updatedPlaybook, exit: true };
  case 'workflow_failed':
    await settle(step.updatedPlaybook, 'failed', step.error);
    return { playbook: step.updatedPlaybook, exit: true };
  case 'waiting_for_sub_agents':
    throw new Error(`Workflow frontier is blocked on nodes: ${ step.missingUpstream.join(', ') }`);
  default:
    throw new Error(`Unsupported workflow action: ${ (step as any).action }`);
  }
}

async function main(): Promise<void> {
  if (!executionId || !runToken) throw new Error('SULLA_EXECUTION_ID and SULLA_RUN_TOKEN are required');
  const leaseToken = crypto.randomUUID();
  const leased = await pool.query(
    `UPDATE workflow_executions
       SET owner_id=$2, lease_token=$3, leased_at=NOW(), heartbeat_at=NOW(),
           lease_expires_at=NOW()+INTERVAL '60 seconds', status='running', updated_at=NOW()
     WHERE execution_id=$1 AND status IN ('running','suspended')
       AND (owner_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= NOW())
     RETURNING *`,
    [executionId, ownerId, leaseToken],
  );
  if (!leased.rowCount) throw new Error(`Execution ${ executionId } is already owned or terminal`);
  let playbook = leased.rows[0].playbook_state as WorkflowPlaybookState;
  if (!playbook) throw new Error(`Execution ${ executionId } has no persisted playbook state`);
  const heartbeat = setInterval(() => void pool.query(
    `UPDATE workflow_executions SET heartbeat_at=NOW(), lease_expires_at=NOW()+INTERVAL '60 seconds'
     WHERE execution_id=$1 AND owner_id=$2 AND lease_token=$3`,
    [executionId, ownerId, leaseToken],
  ), 20_000);
  heartbeat.unref();
  try {
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const outcome = await executeStep(playbook, processNextStep(playbook));
      playbook = outcome.playbook;
      if (outcome.exit) return;
    }
    throw new Error('Workflow exceeded 10,000 runner steps');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    playbook = { ...playbook, status: 'failed', error: message };
    await settle(playbook, 'failed', message);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

void main()
  .catch(error => {
    console.error('[workflow-runner] fatal:', error);
    process.exitCode = 1;
  })
  .finally(async() => {
    await closeEvents();
    await closeDb();
  });
