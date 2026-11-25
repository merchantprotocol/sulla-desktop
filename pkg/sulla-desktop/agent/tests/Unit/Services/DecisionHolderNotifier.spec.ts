// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  graph: undefined as any,
  target: undefined as any,
  definition: undefined as any,
}));

vi.mock('../../../services/GraphRegistry', () => ({ GraphRegistry: { get: vi.fn(() => runtime.graph) } }));
vi.mock('../../../database/models/AgentJobMessagingModel', () => ({ AgentJobMessagingModel: { taskForThread: vi.fn(async() => runtime.target) } }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: vi.fn(async() => runtime.definition) } }));
vi.mock('../../../services/AgentCompletionInbox', () => ({ enqueueAgentCompletion: vi.fn() }));

import { DecisionHolderNotifier } from '../../../services/DecisionHolderNotifier';

const holder = { threadId: 'holder-thread', channel: 'sulla-desktop', agentId: 'worker', jobId: 'worker-job', taskIndex: 0, kind: 'agent' as const };
const record = { id: 'decision-1', conversationId: 'asker-thread', channel: 'sulla-desktop', kind: 'question' as const, status: 'pending' as const };
const task = { jobId: 'worker-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', threadId: 'holder-thread' };

describe('DecisionHolderNotifier holder capability checks', () => {
  beforeEach(() => {
    runtime.graph = { state: { metadata: { threadId: holder.threadId, agentAwareness: true, allowedToolNames: ['agents/answer_decision'] } } };
    runtime.target = task;
    runtime.definition = { allowed_tools: ['agents/answer_decision'], agent_awareness: true };
  });

  it('skips a holder allowed to send job messages but not answer decisions', async() => {
    // risk: authorization — an unrelated agents capability must not masquerade as the answer_decision tool.
    runtime.graph.state.metadata.allowedToolNames = ['agents/send_job_message'];
    runtime.definition.allowed_tools = ['agents/send_job_message'];
    await expect(new DecisionHolderNotifier().canAnswer(record as any, holder)).resolves.toBe(false);
  });

  it('skips an answer-capable holder whose Sees other agents setting is off', async() => {
    // risk: authorization — the holder policy must apply even when answer_decision appears in both tool allowlists.
    runtime.graph.state.metadata.agentAwareness = false;
    await expect(new DecisionHolderNotifier().canAnswer(record as any, holder)).resolves.toBe(false);
  });

  it('does not treat a mismatched running graph as steerable', async() => {
    // risk: availability — a stale graph registration for another thread must not keep a decision with an unreachable holder.
    runtime.graph.state.metadata.threadId = 'different-thread';
    await expect(new DecisionHolderNotifier().canAnswer(record as any, holder)).resolves.toBe(false);
  });

  it('skips a root-chat agent when no live graph proves its answer tool is available', async() => {
    // risk: liveness — an unknown or pruned root graph must not receive an agent deadline instead of the human fallback.
    runtime.graph = undefined;
    const rootHolder = { threadId: 'root-chat', channel: 'sulla-desktop', agentId: 'root-chat', kind: 'agent' as const };
    await expect(new DecisionHolderNotifier().canAnswer(record as any, rootHolder)).resolves.toBe(false);
  });

  it('allows a running exact-tool holder with a matching graph thread', async() => {
    // risk: availability — a currently reachable and authorized holder should receive its escalation turn.
    await expect(new DecisionHolderNotifier().canAnswer(record as any, holder)).resolves.toBe(true);
  });
});
