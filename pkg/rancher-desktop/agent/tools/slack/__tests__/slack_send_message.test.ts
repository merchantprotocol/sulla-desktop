import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { slackToolManifests } from '../manifests';

const mockGet: any = jest.fn();

jest.unstable_mockModule('../../../integrations', () => ({
  registry: {
    get: mockGet,
  },
}));

// slack_send_message imports the slackClient singleton directly; mock it so the
// real module (which eagerly pulls in the Postgres/DB layer) never loads.
jest.unstable_mockModule('../../../integrations/slack/SlackClient', () => ({
  slackClient: {
    isConnected: () => true,
  },
  SlackClient: class {},
}));

// Cut the transitive DB import chain (integrations → IntegrationService →
// Postgres models) that would otherwise load under jsdom.
jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({}),
}));

async function loadSlackSendMessageTool() {
  return import('../slack_send_message');
}

// Source the registration from the canonical tool manifest (single source of
// truth) rather than a bespoke per-tool export.
const slackSendMessageRegistration = slackToolManifests.find(m => m.name === 'slack_send_message')!;

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('slack_send_message tool', () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it('returns success when Slack API confirms message post', async() => {
    const { SlackSendMessageWorker } = await loadSlackSendMessageTool();

    mockGet.mockResolvedValueOnce({
      sendMessage: jest.fn(async() => ({ ok: true, ts: '1234.5678' })),
    });

    const worker = configureWorker(new SlackSendMessageWorker(), slackSendMessageRegistration);
    const result = await worker.invoke({ channel: 'C123', text: 'hello' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Slack message sent successfully');
    expect(result.result).toContain('1234.5678');
  });

  it('returns failure when Slack API returns ok=false', async() => {
    const { SlackSendMessageWorker } = await loadSlackSendMessageTool();

    mockGet.mockResolvedValueOnce({
      sendMessage: jest.fn(async() => ({ ok: false, error: 'channel_not_found' })),
    });

    const worker = configureWorker(new SlackSendMessageWorker(), slackSendMessageRegistration);
    const result = await worker.invoke({ channel: 'C404', text: 'hello' });

    expect(result.success).toBe(false);
    expect(result.result).toContain('Failed to send Slack message');
    expect(result.result).toContain('channel_not_found');
  });

  it('strips internal protocol wrappers before sending to Slack (#96)', async() => {
    const { SlackSendMessageWorker } = await loadSlackSendMessageTool();

    const sendMessage: any = jest.fn(async() => ({ ok: true, ts: '1.2' }));
    mockGet.mockResolvedValueOnce({ sendMessage });

    const worker = configureWorker(new SlackSendMessageWorker(), slackSendMessageRegistration);
    const dirty = 'Here is your answer.\n\n<AGENT_DONE>\n<KEY_RESULT>did the thing</KEY_RESULT>\n</AGENT_DONE>';
    const result = await worker.invoke({ channel: 'C123', text: dirty });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const sentText = sendMessage.mock.calls[0][1];

    expect(sentText).toBe('Here is your answer.');
    expect(sentText).not.toContain('AGENT_DONE');
    expect(sentText).not.toContain('KEY_RESULT');
  });

  it('refuses to send when the message is entirely protocol wrappers (#96)', async() => {
    const { SlackSendMessageWorker } = await loadSlackSendMessageTool();

    const sendMessage: any = jest.fn(async() => ({ ok: true, ts: '1.2' }));
    mockGet.mockResolvedValueOnce({ sendMessage });

    const worker = configureWorker(new SlackSendMessageWorker(), slackSendMessageRegistration);
    const result = await worker.invoke({
      channel: 'C123',
      text:    '<AGENT_DONE><KEY_RESULT>internal only</KEY_RESULT></AGENT_DONE>',
    });

    expect(result.success).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.result).toContain('internal protocol');
  });
});
