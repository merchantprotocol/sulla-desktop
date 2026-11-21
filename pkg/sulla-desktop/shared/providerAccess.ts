// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Safe, renderer-facing connection method metadata. Account identifiers and
 * credential values stay in the main process; this contract carries only the
 * lane needed to explain and gate model selection.
 */
export type ProviderAccessMethod =
  | 'subscription-cli'
  | 'subscription'
  | 'api-key'
  | 'oauth-account'
  | 'cli-account'
  | 'local'
  | 'gateway'
  | 'unknown';

export interface ProviderAccessInfo {
  method:    ProviderAccessMethod;
  label:     string;
  selectable: boolean;
}

export interface ProviderAccessAccount {
  accountId: string;
  connected: boolean;
}

export interface ProviderAccessContext {
  account?:             ProviderAccessAccount;
  cliInstalled?:        boolean;
  integrationAuthType?: 'credentials' | 'oauth';
  supportsOAuth?:       boolean;
  hasApiKeyProperty?:    boolean;
}

const LABELS: Readonly<Record<ProviderAccessMethod, string>> = {
  'subscription-cli': 'Subscription · CLI',
  subscription:       'Subscription · OAuth',
  'api-key':           'API · separate billing',
  'oauth-account':     'OAuth account',
  'cli-account':       'CLI account',
  local:               'On this Mac',
  gateway:             'Gateway',
  unknown:             'Connection unavailable',
};

/**
 * How a model id picks its model: the provider's own default (`automatic`),
 * a CLI family alias whose version the CLI chooses (`alias`), or a literal
 * model id (`exact`).
 */
export type ModelSelectionMode = 'automatic' | 'alias' | 'exact' | 'policy';

export function modelSelectionModeLabel(mode: ModelSelectionMode | undefined, modelId: string): string {
  if (mode === 'policy') return 'Policy · CLI plan/execution';
  if (mode === 'automatic') return 'Automatic · provider default';
  if (mode === 'alias') return `Automatic version · ${ modelId }`;
  return `Exact ID · ${ modelId }`;
}

export function providerAccessLabel(method: ProviderAccessMethod): string {
  return LABELS[method];
}

export function isSubscriptionAccess(method: ProviderAccessMethod): boolean {
  return method === 'subscription' || method === 'subscription-cli';
}

function unknownAccess(): ProviderAccessInfo {
  return { method: 'unknown', label: LABELS.unknown, selectable: false };
}

/**
 * Resolve the selected account's access lane without reading a token. The
 * account ids used for the Claude, Codex and Grok OAuth lanes are the same
 * identity boundary already enforced by their credential resolvers.
 */
export function resolveProviderAccess(providerId: string, context: ProviderAccessContext = {}): ProviderAccessInfo {
  const account = context.account;
  if (account && !account.connected) return unknownAccess();

  if (!account && context.cliInstalled) {
    if (providerId === 'opencode' || providerId === 'cursor') {
      return { method: 'cli-account', label: LABELS['cli-account'], selectable: true };
    }
    return unknownAccess();
  }

  if (!account) return unknownAccess();

  if (providerId === 'claude-code') {
    const method: ProviderAccessMethod = account.accountId === 'oauth' ? 'subscription-cli' : 'api-key';
    return { method, label: LABELS[method], selectable: true };
  }
  if (providerId === 'codex') {
    return { method: 'subscription-cli', label: LABELS['subscription-cli'], selectable: true };
  }
  if (providerId === 'grok') {
    const method: ProviderAccessMethod = account.accountId === 'oauth' ? 'subscription' : 'api-key';
    return { method, label: LABELS[method], selectable: true };
  }
  if (providerId === 'ollama' || providerId === 'lm-studio' || providerId === 'local-server') {
    return { method: 'local', label: LABELS.local, selectable: true };
  }
  if (providerId === 'enterprise_gateway' || providerId === 'enterprise-gateway') {
    return { method: 'gateway', label: LABELS.gateway, selectable: true };
  }
  if (context.integrationAuthType === 'oauth' || context.supportsOAuth) {
    return { method: 'oauth-account', label: LABELS['oauth-account'], selectable: true };
  }
  if (context.integrationAuthType === 'credentials' || context.hasApiKeyProperty) {
    return { method: 'api-key', label: LABELS['api-key'], selectable: true };
  }

  return unknownAccess();
}
