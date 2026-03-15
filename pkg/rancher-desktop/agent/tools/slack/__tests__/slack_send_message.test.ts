import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGet: any = jest.fn();

jest.unstable_mockModule('../../../integrations', () => ({
  registry: {
    get: mockGet,
  },
}));

async function loadSlackSendMessageTool() {
  return import('../slack_send_message');
}

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
    const { SlackSendMessageWorker, slackSendMessageRegistration } = await loadSlackSendMessageTool();

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
    const { SlackSendMessageWorker, slackSendMessageRegistration } = await loadSlackSendMessageTool();

    mockGet.mockResolvedValueOnce({
      sendMessage: jest.fn(async() => ({ ok: false, error: 'channel_not_found' })),
    });

    const worker = configureWorker(new SlackSendMessageWorker(), slackSendMessageRegistration);
    const result = await worker.invoke({ channel: 'C404', text: 'hello' });

    expect(result.success).toBe(false);
    expect(result.result).toContain('Failed to send Slack message');
    expect(result.result).toContain('channel_not_found');
  });
});
