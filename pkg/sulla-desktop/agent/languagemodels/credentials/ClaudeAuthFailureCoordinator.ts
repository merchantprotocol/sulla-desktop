// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AuthExpired, AuthRevoked, type ProviderFailure } from '../failures';
import { claudeCredentialResolver } from './ClaudeCredentialResolver';
import { getIntegrationService } from '../../services/IntegrationService';

export interface ClaudeReconnectRequiredEvent {
  type:          'provider-auth-reconnect-required';
  providerId:    'claude-code';
  integrationId: 'claude-code';
  accountId:     string | null;
  reason:        'expired' | 'revoked';
  message:       'Claude sign-in expired. Reconnect';
  action:        { kind: 'connect'; label: 'Reconnect'; integrationId: 'claude-code' };
}

const handled = new Map<string, number>();
const DEBOUNCE_MS = 30_000;

/** Marks one account disconnected and emits one renderer-safe reconnect event per failure burst. */
export async function handleClaudeAuthFailure(failure: ProviderFailure): Promise<void> {
  if (!(failure instanceof AuthExpired) && !(failure instanceof AuthRevoked)) return;
  const credential = await claudeCredentialResolver.resolve();
  const accountId = credential.accountId;
  const key = accountId ?? 'active';
  const now = Date.now();
  if (now - (handled.get(key) ?? 0) < DEBOUNCE_MS) return;
  handled.set(key, now);

  try {
    await getIntegrationService().setConnectionStatus('claude-code', false, accountId ?? undefined);
  } catch (error) {
    console.warn('[ClaudeAuthFailureCoordinator] Could not mark Claude account disconnected:', error);
  }

  const event: ClaudeReconnectRequiredEvent = {
    type:          'provider-auth-reconnect-required',
    providerId:    'claude-code',
    integrationId: 'claude-code',
    accountId,
    reason:        failure instanceof AuthRevoked ? 'revoked' : 'expired',
    message:       'Claude sign-in expired. Reconnect',
    action:        { kind: 'connect', label: 'Reconnect', integrationId: 'claude-code' },
  };
  try {
    const { BrowserWindow } = await import('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('provider-auth:reconnect-required', event);
    }
  } catch { /* headless agent process: the typed ProviderFailure still reaches its owner */ }
}
