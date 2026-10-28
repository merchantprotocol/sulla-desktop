// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { jest } from '@jest/globals';

// Only the vault lookup and the CLI probe are faked; the integration catalog is the real, hard-coded one.
const connectedInVault = new Set(['claude-code', 'codex', 'grok', 'openai']);

jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({
    isAnyAccountConnected: async(id: string) => connectedInVault.has(id),
    getAccounts:           async() => [],
  }),
}));
jest.unstable_mockModule('../../tools/models/shared', () => ({
  getCliStatus: async(id: string) => ({ required: true, installed: id === 'opencode' }),
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: async(_k: string, d: unknown) => d, set: async() => undefined },
}));
jest.unstable_mockModule('../../integrations/select_box', () => ({ getSelectBoxProvider: () => null }));

describe('ModelProviderService.getAvailableProviders', () => {
  it('lists the vault-connected providers (Claude Code, Codex, Grok) as connected, with an empty database catalog', async() => {
    const { getModelProviderService } = await import('../ModelProviderService');
    const providers = await getModelProviderService().getAvailableProviders();
    const byId = Object.fromEntries(providers.map((p: { id: string; connected: boolean }) => [p.id, p.connected]));

    expect(byId['claude-code']).toBe(true);
    expect(byId.codex).toBe(true);
    expect(byId.grok).toBe(true);
    expect(byId.openai).toBe(true);
    expect(byId.opencode).toBe(true); // CLI installed
    expect(byId.cursor).toBe(false); // CLI missing
    expect(byId.anthropic).toBe(false); // no credential
    // The picker shows connected only: this is what it would render.
    const shown = providers.filter((p: { connected: boolean }) => p.connected).map((p: { id: string }) => p.id).sort();
    expect(shown).toEqual(['claude-code', 'codex', 'grok', 'openai', 'opencode']);
  });
});
