// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registryGet } = vi.hoisted(() => ({ registryGet: vi.fn() }));

vi.mock('../../../../integrations', () => ({
  registry: { get: registryGet },
}));
vi.mock('../../../../integrations/slack/SlackClient', () => ({
  slackClient: { isConnected: () => true },
}));

import { registry } from '../../../../integrations';
import { SlackSendMessageWorker } from '../../../../tools/slack/slack_send_message';

describe('slack_send_message', () => {
  afterEach(() => vi.restoreAllMocks());
  it('passes account through and observes one successful post', async() => {
    // risk: duplicate side effects
    const client = { sendMessage: vi.fn(async() => ({ ok: true, account: 'team-a', teamId: 'T1', ts: '1.2', threadTs: null })) };
    vi.spyOn(registry, 'get').mockResolvedValue(client as any);
    const observer = { onSent: vi.fn() };
    const worker = new SlackSendMessageWorker(observer);
    const result = await (worker as any)._validatedCall({ channel: 'C1', text: 'hello', account: 'team-a' });
    expect(result.successBoolean).toBe(true);
    expect(client.sendMessage).toHaveBeenCalledWith('C1', 'hello', undefined, undefined, undefined, 'team-a');
    expect(observer.onSent).toHaveBeenCalledTimes(1);
  });
  it('does not observe failed posts', async() => {
    // risk: false event recording
    const client = { sendMessage: vi.fn(async() => { throw new Error('denied'); }) };
    vi.spyOn(registry, 'get').mockResolvedValue(client as any);
    const observer = { onSent: vi.fn() };
    const worker = new SlackSendMessageWorker(observer);
    const result = await (worker as any)._validatedCall({ channel: 'C1', text: 'hello' });
    expect(result.successBoolean).toBe(false);
    expect(observer.onSent).not.toHaveBeenCalled();
  });
});
