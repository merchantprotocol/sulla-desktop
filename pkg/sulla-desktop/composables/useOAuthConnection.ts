// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, onScopeDispose, reactive, readonly } from 'vue';

import type { ClaudeOAuthResult } from '@pkg/utils/claudeOAuthContract';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type OAuthConnectionStatus = 'idle' | 'starting' | 'waiting-for-browser' | 'saving' | 'connected' | 'failed' | 'cancelled';
export type OAuthFailureCode = 'offline' | 'timeout' | 'cancelled' | 'port_in_use' | 'vm_not_ready' | 'cli_unavailable' | 'provider_error';

export interface OAuthStartOptions {
  integrationId?: string;
  oauthProviderId?: string;
  accountId?: string;
  clientId?: string;
  clientSecret?: string;
  extraScopes?: string[];
  firstRun?: boolean;
  isConnected?: () => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface OAuthConnectionState {
  status: OAuthConnectionStatus;
  stageText: string;
  errorMessage: string;
  failureCode: OAuthFailureCode | null;
  readonly canRetry: boolean;
}

type OAuthResult = ClaudeOAuthResult | {
  success?: boolean;
  status?: string;
  error?: string;
  message?: string;
  reason?: string;
};

const FAILURE_ALIASES: Record<string, OAuthFailureCode> = {
  offline: 'offline',
  timeout: 'timeout',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  'user-closed': 'cancelled',
  busy_port: 'port_in_use',
  'busy-port': 'port_in_use',
  port_in_use: 'port_in_use',
  collision: 'port_in_use',
  vm_not_ready: 'vm_not_ready',
  'vm-not-ready': 'vm_not_ready',
  cli_unavailable: 'cli_unavailable',
  'cli-missing': 'cli_unavailable',
  provider_error: 'provider_error',
  'provider-error': 'provider_error',
  'no-access': 'provider_error',
};

function textFailureCode(text: string): OAuthFailureCode {
  const lower = text.toLowerCase();
  if (/offline|network|fetch/.test(lower)) return 'offline';
  if (/timed? out|timeout/.test(lower)) return 'timeout';
  if (/cancel|closed/.test(lower)) return 'cancelled';
  if (/port|eaddrinuse|already in use|collision/.test(lower)) return 'port_in_use';
  if (/vm.+not ready|workspace.+not ready/.test(lower)) return 'vm_not_ready';
  if (/cli.+(?:missing|unavailable|not found)/.test(lower)) return 'cli_unavailable';
  return 'provider_error';
}

export function oauthFailureCode(result: unknown): OAuthFailureCode {
  if (result && typeof result === 'object') {
    const value = result as { status?: unknown; reason?: unknown; error?: unknown; message?: unknown };
    for (const candidate of [value.status, value.reason]) {
      if (typeof candidate === 'string' && FAILURE_ALIASES[candidate]) return FAILURE_ALIASES[candidate];
    }
    const detail = typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : '';
    if (detail) return textFailureCode(detail);
  }
  return textFailureCode(result instanceof Error ? result.message : String(result ?? ''));
}

export function oauthFailureMessage(code: OAuthFailureCode, providerName: string, detail = ''): string {
  const name = providerName || 'The provider';
  switch (code) {
  case 'offline': return `${ name } couldn't be reached. Check your connection, then try again.`;
  case 'timeout': return `${ name } sign-in took too long. Try again.`;
  case 'cancelled': return `${ name } sign-in was closed. Try again when you're ready.`;
  case 'port_in_use': return detail || `Another app is using ${ name }'s sign-in port. Quit it and try again.`;
  case 'vm_not_ready': return `Sulla's workspace isn't ready for ${ name } yet. Wait a moment, then try again.`;
  case 'cli_unavailable': return `${ name } sign-in isn't available in Sulla's workspace yet. Wait a moment, then try again.`;
  case 'provider_error': return detail || `${ name } didn't finish signing in. Nothing was lost. Try again.`;
  }
}

function resultDetail(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const value = result as { error?: unknown; message?: unknown };
  return typeof value.error === 'string' && value.error.trim() ? value.error.trim()
    : typeof value.message === 'string' && value.message.trim() ? value.message.trim() : '';
}

export function useOAuthConnection(providerId: string | (() => string), providerName: string | (() => string) = providerId) {
  const resolveProviderId = () => typeof providerId === 'function' ? providerId() : providerId;
  const resolveProviderName = () => typeof providerName === 'function' ? providerName() : providerName;
  const state = reactive<OAuthConnectionState>({
    status: 'idle', stageText: '', errorMessage: '', failureCode: null,
    get canRetry() { return this.status === 'failed' || this.status === 'cancelled'; },
  });
  let attempt = 0;
  let resolveClaudeResult: ((result: OAuthResult) => void) | null = null;

  const onClaudeStage = (_event: unknown, text: unknown) => {
    if (resolveProviderId() === 'claude-code' && typeof text === 'string' && text && ['starting', 'waiting-for-browser'].includes(state.status)) {
      state.status = 'waiting-for-browser';
      state.stageText = text;
    }
  };
  const onClaudeResult = (_event: unknown, result: OAuthResult) => resolveClaudeResult?.(result);
  ipcRenderer.on('claude-oauth:stage' as any, onClaudeStage);
  ipcRenderer.on('claude-oauth:result' as any, onClaudeResult);
  onScopeDispose(() => {
    ipcRenderer.removeListener('claude-oauth:stage' as any, onClaudeStage);
    ipcRenderer.removeListener('claude-oauth:result' as any, onClaudeResult);
  });

  async function start(options: OAuthStartOptions = {}): Promise<boolean> {
    const currentAttempt = ++attempt;
    const id = resolveProviderId();
    state.status = 'starting';
    state.stageText = '';
    state.errorMessage = '';
    state.failureCode = null;
    try {
      state.status = 'waiting-for-browser';
      const claudeResult = id === 'claude-code' ? new Promise<OAuthResult>((resolve) => { resolveClaudeResult = resolve }) : null;
      const invocation: Promise<OAuthResult> = id === 'claude-code'
        ? Promise.race([
          ipcRenderer.invoke('claude-oauth:start', options.firstRun ? { firstRun: true } as any : undefined),
          claudeResult!,
        ])
        : ipcRenderer.invoke('integration-oauth:start', {
          integrationId: options.integrationId ?? id,
          providerId:    options.oauthProviderId ?? id,
          clientId:      options.clientId,
          clientSecret:  options.clientSecret,
          accountId:     options.accountId ?? 'oauth',
          extraScopes:   options.extraScopes,
          firstRun:      options.firstRun,
        });
      let result: OAuthResult;
      if (options.isConnected) {
        result = await new Promise<OAuthResult>((resolve, reject) => {
          let finished = false;
          const finish = (value: OAuthResult) => {
            if (finished) return;
            finished = true;
            clearInterval(poll);
            clearTimeout(deadline);
            resolve(value);
          };
          const poll = setInterval(() => {
            if (currentAttempt !== attempt) {
              finish({ success: false, status: 'cancelled', reason: 'user-closed' });
              return;
            }
            void options.isConnected!().then(connected => {
              if (connected) finish({ success: true });
            }).catch(() => undefined);
          }, options.pollIntervalMs ?? 3_000);
          const deadline = setTimeout(() => finish({ success: false, status: 'timeout', reason: 'timeout' }), options.timeoutMs ?? 6 * 60_000);
          invocation.then(finish, (error) => {
            if (finished) return;
            finished = true;
            clearInterval(poll);
            clearTimeout(deadline);
            reject(error);
          });
        });
      } else {
        result = await invocation;
      }
      if (id === 'claude-code') resolveClaudeResult = null;
      if (currentAttempt !== attempt) return false;
      if (result?.success === true) {
        state.status = 'saving';
        state.status = 'connected';
        return true;
      }
      const code = oauthFailureCode(result);
      state.failureCode = code;
      state.errorMessage = oauthFailureMessage(code, resolveProviderName(), resultDetail(result));
      state.status = code === 'cancelled' ? 'cancelled' : 'failed';
      return false;
    } catch (error) {
      if (resolveProviderId() === 'claude-code') resolveClaudeResult = null;
      if (currentAttempt !== attempt) return false;
      const code = oauthFailureCode(error);
      state.failureCode = code;
      state.errorMessage = oauthFailureMessage(code, resolveProviderName(), error instanceof Error ? error.message : '');
      state.status = code === 'cancelled' ? 'cancelled' : 'failed';
      return false;
    }
  }

  function cancel(): void {
    attempt++;
    const id = resolveProviderId();
    if (id === 'claude-code') void ipcRenderer.invoke('claude-oauth:cancel').catch(() => undefined);
    else void ipcRenderer.invoke('integration-oauth:cancel' as any, id).catch(() => undefined);
    state.status = 'cancelled';
    state.stageText = '';
    state.failureCode = 'cancelled';
    state.errorMessage = oauthFailureMessage('cancelled', resolveProviderName());
  }

  return {
    state: readonly(state),
    canRetry: computed(() => state.status === 'failed' || state.status === 'cancelled'),
    start,
    cancel,
  };
}
