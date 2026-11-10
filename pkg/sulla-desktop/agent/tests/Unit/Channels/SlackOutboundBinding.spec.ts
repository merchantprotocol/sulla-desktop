// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { InMemoryConversationBindingRepository } from '../../../channels/InMemoryConversationBindingRepository';
import { InboundRouterService } from '../../../channels/InboundRouterService';
import { OutboundSlackMessageObserver } from '../../../tools/slack/OutboundSlackMessageObserver';
import { SlackThreadContextSource } from '../../../channels/SlackThreadContextSource';
import { SlackWorkspaceAccountRegistry } from '../../../channels/SlackWorkspaceAccountRegistry';
import type { InboundMessage } from '../../../channels/types';

const inbound: InboundMessage = { channel: 'slack', workspaceId: 'T1', conversationId: 'C1', threadKey: 'root', messageTs: 'reply', senderId: 'U1', text: 'answer', isDirectMessage: false, eventId: 'e1' };
const context = { issue: vi.fn(async() => ({} as any)) };

describe('Slack outbound binding and thread context', () => {
  it('binds a chat-origin send to its Slack thread, then routes a reply to that chat', async() => {
    // risk: reply routing
    const repository = new InMemoryConversationBindingRepository();
    const observer = new OutboundSlackMessageObserver(repository);
    await observer.onSent({ account: 'a1', teamId: 'T1', channel: 'C1', ts: 'root', threadTs: null,
      executionContext: { thread_id: 'chat-1', agent_id: 'agent-1' } as any });
    const router = new InboundRouterService(repository, { allows: async() => true }, { create: async() => 'wrong' }, { fetchRecent: async() => [] });
    const routed = await router.route(inbound);
    expect(routed?.binding.target).toEqual({ kind: 'chat', threadId: 'chat-1' });
    expect(routed?.binding.agentId).toBe('agent-1');
  });
  it('binds an agent job with its signed task index and ignores sends without caller context', async() => {
    // risk: tenant/job attribution
    const repository = new InMemoryConversationBindingRepository();
    const observer = new OutboundSlackMessageObserver(repository);
    await observer.onSent({ account: 'a1', teamId: 'T1', channel: 'C1', ts: '2', threadTs: 'root',
      executionContext: { job_id: 'job-1', task_index: 3, agent_id: 'agent-2' } as any });
    await observer.onSent({ account: 'a1', teamId: 'T1', channel: 'C1', ts: '3', threadTs: null });
    const routed = await new InboundRouterService(repository, { allows: async() => true }, { create: async() => 'wrong' }, { fetchRecent: async() => [] }).route(inbound);
    expect(routed?.binding.target).toEqual({ kind: 'job', jobId: 'job-1', taskIndex: 3 });
  });
  it('routes concurrent fallback creation through the binding returned by the repository', async() => {
    // risk: duplicate fallback conversations under inbound event races
    const repository = new InMemoryConversationBindingRepository();
    let count = 0;
    const router = new InboundRouterService(repository, { allows: async() => true }, { create: async() => `chat-${++count}` }, { fetchRecent: async() => [] });
    const [first, second] = await Promise.all([router.route(inbound), router.route({ ...inbound, eventId: 'e2' })]);
    expect(first?.binding.target).toEqual(second?.binding.target);
  });
  it('includes Slack reply parameters from the workspace mapping in routed provenance', async() => {
    // risk: reply routing to the wrong account or thread
    const accounts = new SlackWorkspaceAccountRegistry(); accounts.register('T1', 'a1');
    const router = new InboundRouterService(new InMemoryConversationBindingRepository(), { allows: async() => true }, { create: async() => 'chat' }, { fetchRecent: async() => [] }, accounts);
    expect((await router.route(inbound))?.content).toContain('Reply with slack/send_message using channel=C1, thread_ts=root, account=a1');
  });
  it('fetches at most ten thread replies and returns empty context on Slack failure', async() => {
    // risk: Slack outage must not break inbound routing
    const accounts = new SlackWorkspaceAccountRegistry(); accounts.register('T1', 'a1');
    const api = { threadReplies: vi.fn().mockResolvedValue({ messages: [{ user: 'U1', text: 'hello', ts: '1' }] }) };
    const source = new SlackThreadContextSource(api as any, accounts, context as any);
    expect(await source.fetchRecent('T1', 'C1', 'root', 25)).toEqual(['U1: hello (1)']);
    expect(api.threadReplies).toHaveBeenCalledWith('C1', 'root', 10, {}, 'a1');
    api.threadReplies.mockRejectedValueOnce(new Error('offline'));
    expect(await source.fetchRecent('T1', 'C1', 'root', 10)).toEqual([]);
  });
});
