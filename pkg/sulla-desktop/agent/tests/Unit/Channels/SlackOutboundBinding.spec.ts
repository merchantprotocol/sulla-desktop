// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

const { integrationService, getAccounts } = vi.hoisted(() => {
  const getAccounts = vi.fn();
  return { integrationService: { getAccounts }, getAccounts };
});

vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => integrationService }));
vi.mock('@pkg/agent/app/Repositories/PostgresConversationBindingRepository', () => ({ PostgresConversationBindingRepository: class {} }));
vi.mock('@pkg/agent/integrations/slack/BrokerSlackApiTransport', () => ({ BrokerSlackApiTransport: class {} }));
vi.mock('@pkg/agent/integrations/slack/SlackAccountResolver', () => ({ SlackAccountResolver: class {} }));
vi.mock('@pkg/agent/integrations/slack/SlackWebApiClient', () => ({ SlackWebApiClient: class {} }));
vi.mock('@pkg/agent/integrations/slack/SlackSystemContextIssuer', () => ({ SlackSystemContextIssuer: class {} }));
vi.mock('@pkg/agent/channels/ChannelInboundDelivery', () => ({ ChannelInboundDelivery: class {} }));
vi.mock('@pkg/main/cloud/slack/SlackInboundServices', () => ({ ExistingSlackJobSender: class {}, LocalSlackChatSender: class {}, ConversationHistorySlackThreadFactory: class {} }));
vi.mock('@pkg/main/cloud/slack/SlackCloudClient', () => ({ SlackCloudClient: class {} }));
import { InMemoryConversationBindingRepository } from '../../../channels/InMemoryConversationBindingRepository';
import { InboundRouterService } from '../../../channels/InboundRouterService';
import { OutboundSlackMessageObserver } from '../../../tools/slack/OutboundSlackMessageObserver';
import { SlackThreadContextSource } from '../../../channels/SlackThreadContextSource';
import { SlackWorkspaceAccountRegistry } from '../../../channels/SlackWorkspaceAccountRegistry';
import type { InboundMessage } from '../../../channels/types';
import { SlackWorkspaceRegistrar } from '@pkg/main/cloud/slack/SlackWorkspaceRegistrar';
import { SlackInboundRuntime } from '@pkg/main/cloud/slack/SlackInboundRuntime';

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

describe('Slack workspace registration is best-effort', () => {
  const account = { account_id: 'a1', connected: true, credentialRequired: true };
  const issuer = { issue: vi.fn(async() => ({})) };
  const frame = { type: 'slack_inbound', eventId: 'e1' };

  it('records the team-to-account mapping even when Cloud registration throws', async() => {
    // risk: replies and thread context fail to resolve the right workspace account
    getAccounts.mockResolvedValueOnce([account]);
    const accounts = new SlackWorkspaceAccountRegistry();
    const api = { authTest: vi.fn(async() => ({ team_id: 'T1', bot_id: 'B1' })), botsInfo: vi.fn(async() => ({ bot: { app_id: 'A1' } })) };
    const cloud = { registerWorkspace: vi.fn(async() => { throw new Error('Slack workspace registration failed (500)'); }) };
    await new SlackWorkspaceRegistrar(cloud as any, accounts, integrationService as any, issuer as any, api as any).registerConnectedWorkspaces();
    expect(cloud.registerWorkspace).toHaveBeenCalledTimes(1);
    expect(accounts.resolve('T1')).toBe('a1');
  });
  it('does not retry a workspace Cloud reports as claimed', async() => {
    // risk: registration retry loops hammering Cloud
    getAccounts.mockResolvedValue([account]);
    const accounts = new SlackWorkspaceAccountRegistry();
    const api = { authTest: vi.fn(async() => ({ team_id: 'T1', bot_id: 'B1' })), botsInfo: vi.fn(async() => ({ bot: { app_id: 'A1' } })) };
    const cloud = { registerWorkspace: vi.fn(async() => { throw new Error('workspace_claimed'); }) };
    const registrar = new SlackWorkspaceRegistrar(cloud as any, accounts, integrationService as any, issuer as any, api as any);
    await registrar.registerConnectedWorkspaces();
    await registrar.registerConnectedWorkspaces();
    expect(cloud.registerWorkspace).toHaveBeenCalledTimes(1);
    expect(accounts.resolve('T1')).toBe('a1');
  });
  it('still routes an inbound frame when workspace registration fails', async() => {
    // risk: a vault-locked boot silently drops Slack inbound messages
    getAccounts.mockReset();
    getAccounts.mockRejectedValue(new Error('vault locked'));
    const processor = { handle: vi.fn(async() => {}) };
    const cloud = { ack: vi.fn(), pending: vi.fn(async() => []) };
    const runtime = new SlackInboundRuntime(cloud as any, processor as any);
    await runtime.handle(frame);
    expect(processor.handle).toHaveBeenCalledWith(frame);
  });
  it('runs registration at most once per minute', async() => {
    // risk: Cloud and vault hammered on every inbound frame
    getAccounts.mockReset();
    getAccounts.mockResolvedValue([]);
    const processor = { handle: vi.fn(async() => {}) };
    const runtime = new SlackInboundRuntime({ ack: vi.fn(), pending: vi.fn(async() => []) } as any, processor as any);
    await runtime.handle(frame);
    await runtime.handle({ ...frame, eventId: 'e2' });
    expect(getAccounts).toHaveBeenCalledTimes(1);
    expect(processor.handle).toHaveBeenCalledTimes(2);
  });
});
