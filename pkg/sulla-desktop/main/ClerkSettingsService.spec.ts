// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { ClerkSettingsService } from './ClerkSettingsService';

function metadata(revision: number, allowedAgentIds: string[] = []) {
  return {
    integrationId:   'clerk',
    activeAccountId: 'default',
    accounts:        [{
      accountId:          'default',
      label:              'Clerk',
      connected:          false,
      credentialRequired: false,
      active:             true,
      revision,
      properties:         {},
      allowedAgentIds,
    }],
  };
}

describe('Clerk settings allow-list persistence', () => {
  it('loads the vault allow list and confirms a policy-only save without returning keys', async() => {
    const broker = {
      integrationMetadata: vi.fn().mockResolvedValueOnce(metadata(4, ['research-agent']))
        .mockResolvedValueOnce(metadata(4, ['research-agent']))
        .mockResolvedValueOnce(metadata(5, ['research-agent', 'coding-manager'])),
    };
    const owner = { importIntegrationAccount: vi.fn().mockResolvedValue(metadata(5, ['research-agent', 'coding-manager'])) };
    const service = new ClerkSettingsService(() => owner as never, () => broker as never, () => {});

    await expect(service.load()).resolves.toMatchObject({ success: true, allowedAgentIds: ['research-agent'] });
    await expect(service.save({ allowedAgentIds: ['research-agent', 'coding-manager'] })).resolves.toMatchObject({
      success:         true,
      allowedAgentIds: ['research-agent', 'coding-manager'],
    });
    expect(owner.importIntegrationAccount).toHaveBeenCalledWith('clerk', {
      accountId:       'default',
      label:           'Clerk',
      values:          {},
      connected:       true,
      active:          true,
      allowedAgentIds: ['research-agent', 'coding-manager'],
    });
  });

  it.each([
    ['not an id'],
    ['same-agent', 'same-agent'],
  ])('rejects an invalid allow-list before contacting the vault', async(...allowedAgentIds) => {
    const broker = { integrationMetadata: vi.fn().mockResolvedValue(metadata(4)) };
    const owner = { importIntegrationAccount: vi.fn() };
    const service = new ClerkSettingsService(() => owner as never, () => broker as never, () => {});

    await expect(service.save({ allowedAgentIds })).resolves.toMatchObject({
      success: false, error: 'The Clerk settings contain an invalid agent list.',
    });
    expect(owner.importIntegrationAccount).not.toHaveBeenCalled();
    expect(broker.integrationMetadata).not.toHaveBeenCalled();
  });
});
