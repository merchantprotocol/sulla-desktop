// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, jest, test } from '@jest/globals';

import { IntegrationService } from '../IntegrationService';
import { configureCredentialBroker } from '../../../vault-broker';

describe('IntegrationService container account metadata', () => {
  afterEach(() => configureCredentialBroker(null));

  test('getActiveAccountId resolves the account activated by an atomic Desktop import', async() => {
    configureCredentialBroker({
      integrationMetadata: jest.fn(async() => ({
        integrationId: 'synthetic-ai', activeAccountId: 'desktop-account',
        accounts: [{ accountId: 'desktop-account', label: 'Synthetic desktop', active: true, connected: true, credentialRequired: true, revision: 1, properties: { connection_status: 'connected' } }],
      })),
    } as any);
    await expect(new IntegrationService().getActiveAccountId('synthetic-ai')).resolves.toBe('desktop-account');
  });
});
