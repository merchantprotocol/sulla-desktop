// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { isSubscriptionAccess, modelSelectionModeLabel, providerAccessLabel, resolveProviderAccess } from '@pkg/shared/providerAccess';
import { modelSelectionLabel, providerKind } from '@pkg/components/settings/sections/modelRouting/routingLogic';

describe('provider access metadata', () => {
  it('distinguishes subscription CLI, subscription, and API-key lanes from the selected account', () => {
    const claudeSubscription = resolveProviderAccess('claude-code', { account: { accountId: 'oauth', connected: true } });
    const claudeApi = resolveProviderAccess('claude-code', { account: { accountId: 'team-key', connected: true } });
    const grokSubscription = resolveProviderAccess('grok', { account: { accountId: 'oauth', connected: true } });
    const grokApi = resolveProviderAccess('grok', { account: { accountId: 'developer-key', connected: true } });

    expect(claudeSubscription).toEqual({ method: 'subscription-cli', label: 'Subscription · CLI', selectable: true });
    expect(claudeApi).toEqual({ method: 'api-key', label: 'API · separate billing', selectable: true });
    expect(grokSubscription).toEqual({ method: 'subscription', label: 'Subscription · OAuth', selectable: true });
    expect(grokApi).toEqual({ method: 'api-key', label: 'API · separate billing', selectable: true });
    expect(isSubscriptionAccess(claudeSubscription.method)).toBe(true);
    expect(isSubscriptionAccess(grokSubscription.method)).toBe(true);
    expect(isSubscriptionAccess(grokApi.method)).toBe(false);
  });

  it('fails closed for missing or disconnected accounts while retaining CLI-owned lanes', () => {
    expect(resolveProviderAccess('grok')).toEqual({ method: 'unknown', label: 'Connection unavailable', selectable: false });
    expect(resolveProviderAccess('grok', { account: { accountId: 'oauth', connected: false } })).toEqual({ method: 'unknown', label: 'Connection unavailable', selectable: false });
    expect(resolveProviderAccess('grok', { account: { accountId: 'oauth', connected: true }, supportsOAuth: true })).toEqual({ method: 'subscription', label: 'Subscription · OAuth', selectable: true });
    expect(resolveProviderAccess('opencode', { cliInstalled: true })).toEqual({ method: 'cli-account', label: 'CLI account', selectable: true });
    expect(resolveProviderAccess('cursor', { cliInstalled: true })).toEqual({ method: 'cli-account', label: 'CLI account', selectable: true });
    expect(resolveProviderAccess('opencode', { cliInstalled: false })).toEqual({ method: 'unknown', label: 'Connection unavailable', selectable: false });
  });

  it('uses actual routing metadata for access and automatic-versus-exact labels', () => {
    const state: any = {
      providers: [{
        id: 'grok', name: 'Grok', connected: true, local: false, subscription: true, status: 'ready', coolingUntil: null, lastError: null,
        accessMethod: 'subscription', accessLabel: 'Subscription · OAuth',
        models: [
          { id: 'grok', label: 'Auto (provider default)', selectionMode: 'automatic' },
          { id: 'grok-4.6', label: 'Grok 4.6', selectionMode: 'exact' },
        ],
      }, {
        id: 'claude-code', name: 'Claude Code', connected: true, local: false, subscription: true, status: 'ready', coolingUntil: null, lastError: null,
        accessMethod: 'subscription-cli', accessLabel: 'Subscription · CLI',
        models: [
          { id: 'claude-code', label: 'Auto (Claude picks)', selectionMode: 'automatic' },
          { id: 'opus', label: 'Opus 5.5 (CLI alias)', selectionMode: 'alias' },
          { id: 'claude-opus-5-5', label: 'Opus 5.5', selectionMode: 'exact' },
        ],
      }],
    };

    expect(providerKind(state, 'grok')).toBe('Subscription · OAuth');
    expect(providerKind({ providers: [] }, 'grok')).toBe('Connection method unavailable');
    expect(modelSelectionLabel(state, 'grok', 'grok')).toBe('Automatic · provider default');
    expect(modelSelectionLabel(state, 'grok', 'grok-4.6')).toBe('Exact ID · grok-4.6');
    expect(modelSelectionLabel(state, 'claude-code', 'claude-code')).toBe('Automatic · provider default');
    expect(modelSelectionLabel(state, 'claude-code', 'opus')).toBe('Automatic version · opus');
    expect(modelSelectionLabel(state, 'claude-code', 'claude-opus-5-5')).toBe('Exact ID · claude-opus-5-5');
    expect(modelSelectionModeLabel(undefined, 'unlisted-id')).toBe('Exact ID · unlisted-id');
    expect(providerAccessLabel('api-key')).toBe('API · separate billing');
  });
});
