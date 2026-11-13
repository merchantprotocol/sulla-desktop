// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';
import { CliFaultError, runWithCliFaultRecovery } from '../../../languagemodels/cliFaultRecovery';
import { AuthExpired, AuthRevoked, legacyProviderFailure } from '../../../languagemodels/failures';
import { ProviderBridgeDeniedFailure, classifyLLMFailure } from '../../../languagemodels/providerRecovery';
import { ProviderBridgeRevokedError, createProviderCliBridge } from '../../../../vault-broker/providerCliBridge';

vi.mock('../../../../vault-broker/index', () => ({ requireConfiguredCredentialBroker: vi.fn() }));

const policy = new ModelRecoveryPolicy();
const denied = 'Claude Code: Failed to authenticate. API Error: 403 Provider bridge request denied (provider_model_denied)';

describe('provider bridge denial fails fast', () => {
  it('runs a CLI whose bridge lease was denied exactly once', async() => {
    // risk: wasted CLI runs and duplicate side effects against a denied lease
    const operation = vi.fn(async() => { throw new CliFaultError('process_exit', denied) });
    await expect(runWithCliFaultRecovery('Claude Code', operation, { canRetry: () => true, backoffMs: 0 }))
      .rejects.toBeInstanceOf(ProviderBridgeDeniedFailure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops model routing on a denial: no same-model retries and no fallback cascade', async() => {
    // risk: one revoked lifecycle fanning out into 3 attempts per fallback candidate
    const operation = vi.fn(async() => { throw new CliFaultError('process_exit', denied) });
    const error = await runWithCliFaultRecovery('Claude Code', operation, { canRetry: () => true, backoffMs: 0 }).catch(e => e);
    const recovery = classifyLLMFailure(error);
    expect(recovery.kind).toBe('infrastructure');
    expect(policy.additionalAttempts(recovery)).toBe(0);
    expect(policy.canAdvance(recovery)).toBe(false);
  });

  it('still retries a transient bridge outage', async() => {
    // risk: over-correcting turns a brief vault blip into a failed turn
    const operation = vi.fn()
      .mockRejectedValueOnce(new CliFaultError('process_exit', 'Codex: unexpected status 503: Sulla provider bridge is temporarily unavailable'))
      .mockResolvedValueOnce('ok');
    await expect(runWithCliFaultRecovery('Codex', operation, { canRetry: () => true, backoffMs: 0 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('never reads a bridge 401/403 as an expired or revoked Claude sign-in', () => {
    // risk: Sulla-side lease denial disconnecting the user's real Claude account
    for (const message of [
      'Failed to authenticate. API Error: 401 Provider bridge request denied (invalid_bridge_capability)',
      'Failed to authenticate. API Error: 403 Provider bridge request denied (provider_bridge_revoked)',
    ]) {
      const failure = legacyProviderFailure('claude-code', message);
      expect(failure).not.toBeInstanceOf(AuthExpired);
      expect(failure).not.toBeInstanceOf(AuthRevoked);
    }
    expect(legacyProviderFailure('claude-code', 'Failed to authenticate. API Error: 401 invalid api key')).toBeInstanceOf(AuthExpired);
  });
});

describe('revoked bridge lifecycle', () => {
  const now = Math.floor(Date.now() / 1000);
  const context = {
    v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'user-1', agent_id: 'agent-1', pod_id: 'pod-1',
    thread_id: 'thread-1', job_id: 'job-1', device_id: 'device-1',
    credential_scope: { integration_id: 'codex', account_id: 'acct-1' }, scopes: [], iat: now, exp: now + 300, jti: 'jti-1',
  } as any;

  it('refuses to mint a lease for an ended lifecycle with a non-retryable Sulla failure', async() => {
    // risk: an ended job's lease being retried 3x per model candidate
    const lifecycle = new AbortController();
    lifecycle.abort();
    const authorize = vi.fn(() => true);
    const error = await createProviderCliBridge({
      context, provider: 'codex', accountId: 'acct-1', authorize, signal: lifecycle.signal,
    }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderBridgeRevokedError);
    expect(authorize).not.toHaveBeenCalled();
    const recovery = classifyLLMFailure(error);
    expect(recovery.kind).toBe('infrastructure');
    expect(policy.additionalAttempts(recovery)).toBe(0);
    expect(policy.canAdvance(recovery)).toBe(false);
  });
});
