// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

const { createRelay } = vi.hoisted(() => ({
  createRelay: vi.fn(async() => ({ relayId: 'relay-test', expiresAt: Date.now() + 60_000 })),
}));

vi.mock('../../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => true,
  requireConfiguredCredentialBroker: () => ({ createRelay }),
  issueLocalBrokerContext: vi.fn(async() => ({})),
}));

vi.mock('../../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    initialize: vi.fn(async() => undefined),
    getActiveAccountId: vi.fn(async() => 'team-a'),
    getIntegrationValue: vi.fn(async() => ({ value: 'unused' })),
  }),
}));

import { SlackClient } from '../../../../integrations/slack/SlackClient';

describe('SlackClient', () => {
  it('initializes without creating a Socket Mode relay', async() => {
    // risk: availability
    expect(await SlackClient.getInstance().initialize()).toBe(true);
    expect(createRelay).not.toHaveBeenCalled();
  });
});
