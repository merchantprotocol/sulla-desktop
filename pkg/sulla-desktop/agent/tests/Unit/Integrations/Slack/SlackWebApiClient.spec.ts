// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SlackAccountResolver } from '../../../../integrations/slack/SlackAccountResolver';
import { SlackApiError } from '../../../../integrations/slack/SlackApiError';
import { SlackWebApiClient } from '../../../../integrations/slack/SlackWebApiClient';
import type { SlackApiTransport } from '../../../../integrations/slack/SlackApiTransport';

const resolver = (accounts = ['team-a']) => new SlackAccountResolver({
  getActiveAccountId: vi.fn(async() => 'team-a'),
  getAccounts: vi.fn(async() => accounts.map(account_id => ({ account_id, credentialRequired: true } as any))),
} as any);
const transport = (body: any, status = 200) => ({ call: vi.fn(async() => ({ status, body })) });

describe('SlackWebApiClient', () => {
  it('posts with Slack method parameters and returns message timestamp', async() => {
    // risk: data accuracy
    const fake = transport({ ok: true, ts: '1732000000.100', team_id: 'T1' });
    const client = new SlackWebApiClient(fake as unknown as SlackApiTransport, resolver());
    const result = await client.postMessage('C1', 'hello');
    expect(result.ts).toBe('1732000000.100');
    expect(result.teamId).toBe('T1');
    expect(fake.call).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'team-a', method: 'chat.postMessage', body: expect.objectContaining({ channel: 'C1', text: 'hello' }) }));
  });
  it('rejects Slack API errors without reflecting credential values', async() => {
    // risk: credential privacy
    const fake = transport({ ok: false, error: 'missing_scope', token: 'xoxb-never-show' });
    const client = new SlackWebApiClient(fake as unknown as SlackApiTransport, resolver());
    await expect(client.call('auth.test')).rejects.toBeInstanceOf(SlackApiError);
    await expect(client.call('auth.test')).rejects.not.toThrow('xoxb-never-show');
  });
  it('rejects an unknown account before transport', async() => {
    // risk: tenant isolation
    const fake = transport({ ok: true });
    const client = new SlackWebApiClient(fake as unknown as SlackApiTransport, resolver());
    await expect(client.call('auth.test', {}, undefined, 'other')).rejects.toThrow('Unknown Slack account');
    expect(fake.call).not.toHaveBeenCalled();
  });
  it('uses the active account when none is specified', async() => {
    // risk: workspace routing
    const fake = transport({ ok: true });
    const client = new SlackWebApiClient(fake as unknown as SlackApiTransport, resolver());
    await client.call('auth.test');
    expect(fake.call).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'team-a' }));
  });
});
