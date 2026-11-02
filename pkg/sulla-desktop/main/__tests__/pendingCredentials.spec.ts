// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, jest, test } from '@jest/globals';

const importIntegrationAccount: any = jest.fn();

jest.unstable_mockModule('electron', () => ({
  default: { app: { isPackaged: true }, BrowserWindow: { getAllWindows: () => [] } },
}));
jest.unstable_mockModule('../../vault-broker', () => ({
  usesContainerVaultAuthority: () => true,
  getConfiguredApprovalClient: () => ({ importIntegrationAccount }),
}));
jest.unstable_mockModule('../../agent/services/IntegrationService', () => ({ getIntegrationService: jest.fn() }));
jest.unstable_mockModule('../../agent/services/ServiceLifecycleManager', () => ({ getServiceLifecycleManager: jest.fn() }));
jest.unstable_mockModule('../firstRun/firstRunTrace', () => ({ firstRunTrace: jest.fn() }));
jest.unstable_mockModule('../firstRun/firstRunState', () => ({ getFirstRunState: jest.fn(), updateFirstRunState: jest.fn() }));
jest.unstable_mockModule('../../agent/services/brokeredModelList', () => ({ clearBrokeredModelListCache: jest.fn() }));
jest.unstable_mockModule('../../agent/languagemodels/codexModelCatalog', () => ({ clearCodexModelCatalogCache: jest.fn() }));
jest.unstable_mockModule('../../agent/languagemodels/claudeModelCatalog', () => ({ clearClaudeModelCatalogCache: jest.fn() }));

describe('pending credential Desktop-account handoff', () => {
  test('connect flush atomically imports connected active metadata without using secret egress', async() => {
    const { flushPendingCredentials, queuePendingCredential } = await import('../firstRun/pendingCredentials');
    importIntegrationAccount.mockResolvedValueOnce({
      integrationId: 'synthetic-ai', activeAccountId: 'desktop-account',
      accounts: [{ accountId: 'desktop-account', active: true, connected: true }],
    });
    queuePendingCredential({
      integrationId: 'synthetic-ai', accountId: 'desktop-account', activate: true,
      values: { account_label: 'Synthetic desktop', api_key: 'synthetic-key' },
    });

    await expect(flushPendingCredentials()).resolves.toEqual({
      flushed: ['synthetic-ai'], failed: [], failures: {},
    });
    expect(importIntegrationAccount).toHaveBeenCalledWith('synthetic-ai', {
      accountId: 'desktop-account', label: 'Synthetic desktop',
      // The pending buffer is wiped immediately after the handoff resolves;
      // Jest retains this same object reference, proving cleanup as well.
      values: {}, active: true, connected: true,
    });
  });
});
