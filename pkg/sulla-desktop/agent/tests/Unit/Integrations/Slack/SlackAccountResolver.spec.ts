// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SlackAccountResolver } from '../../../../integrations/slack/SlackAccountResolver';

describe('SlackAccountResolver', () => {
  it('uses the active Slack account when no account is supplied', async() => {
    // risk: workspace routing
    const getActiveAccountId = vi.fn(async() => 'team-a');
    const resolver = new SlackAccountResolver({
      getActiveAccountId,
      getAccounts: vi.fn(async() => []),
    } as any);

    await expect(resolver.resolve()).resolves.toBe('team-a');
    expect(getActiveAccountId).toHaveBeenCalledWith('slack');
  });

  it('accepts only configured credential-bearing Slack accounts', async() => {
    // risk: tenant isolation
    const resolver = new SlackAccountResolver({
      getActiveAccountId: vi.fn(async() => 'team-a'),
      getAccounts: vi.fn(async() => [
        { account_id: 'team-a', credentialRequired: true },
        { account_id: 'disabled', credentialRequired: false },
      ]),
    } as any);

    await expect(resolver.resolve('team-a')).resolves.toBe('team-a');
    await expect(resolver.resolve('unknown')).rejects.toThrow('Unknown Slack account');
    await expect(resolver.resolve('disabled')).rejects.toThrow('Unknown Slack account');
  });
});
