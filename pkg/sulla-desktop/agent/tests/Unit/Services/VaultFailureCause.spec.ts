// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { recordVaultFailure, recordVaultSuccess, vaultFailureKind, vaultFailureSince } from '../../../../vault-broker/vaultHealth';
import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';
import { CliFaultError, CliRecoveryExhaustedError, runWithCliFaultRecovery } from '../../../languagemodels/cliFaultRecovery';
import { VaultLocked, VaultUnreachable } from '../../../languagemodels/failures';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';

import type { VaultGate } from '../../../languagemodels/vaultGate';

vi.mock('../../../../vault-broker/index', () => ({ requireConfiguredCredentialBroker: vi.fn() }));

const exitFault = () => new CliFaultError('process_exit', 'Claude Code: claude exited with code 1');

/** A gate whose vault failed during the run and comes back (or not) when waited on. */
function gate(kind: 'locked' | 'unreachable' | undefined, comesBack: boolean): VaultGate & { waits: number } {
  return {
    waits:        0,
    failureSince: () => kind,
    async waitUntilAvailable() {
      this.waits++;

      return comesBack;
    },
  };
}

describe('vault health from bridge failures', () => {
  it('maps a 423 or vault_locked to locked and vault outages to unreachable', () => {
    expect(vaultFailureKind(423, undefined)).toBe('locked');
    expect(vaultFailureKind(502, 'vault_locked')).toBe('locked');
    expect(vaultFailureKind(503, 'vault_unreachable_ERR_INSUFFICIENT_RESOURCES')).toBe('unreachable');
    expect(vaultFailureKind(503, 'vault_starting')).toBe('unreachable');
    expect(vaultFailureKind(502, 'upstream_failed')).toBeUndefined();
  });

  it('only reports refusals from the current run window and clears on success', () => {
    recordVaultFailure('locked', 1_000);
    expect(vaultFailureSince(500)).toBe('locked');
    expect(vaultFailureSince(2_000)).toBeUndefined();
    recordVaultSuccess();
    expect(vaultFailureSince(0)).toBeUndefined();
  });
});

describe('CLI recovery with a vault outage', () => {
  // risk: a locked vault burning every retry and ending as "Claude stopped after its recovery attempts"
  it('waits for the vault, then retries without spending an attempt', async() => {
    const vault = gate('locked', true);
    const operation = vi.fn()
      .mockRejectedValueOnce(exitFault())
      .mockResolvedValueOnce('ok');
    const onVaultWait = vi.fn();

    await expect(runWithCliFaultRecovery('Claude Code', operation, { canRetry: () => true, backoffMs: 0, vaultGate: vault, onVaultWait, maxAttempts: 1 }))
      .resolves.toBe('ok');
    expect(vault.waits).toBe(1);
    expect(onVaultWait).toHaveBeenCalledWith('locked');
  });

  // risk: the user is told about the model instead of the vault that actually blocked it
  it('reports the vault, not the model, when it never comes back', async() => {
    const locked = await runWithCliFaultRecovery('Claude Code', vi.fn(async() => { throw exitFault() }),
      { canRetry: () => true, backoffMs: 0, vaultGate: gate('locked', false) }).catch(e => e);
    const unreachable = await runWithCliFaultRecovery('Claude Code', vi.fn(async() => { throw exitFault() }),
      { canRetry: () => true, backoffMs: 0, vaultGate: gate('unreachable', false) }).catch(e => e);

    expect(locked).toBeInstanceOf(VaultLocked);
    expect(locked.message).toMatch(/Password Vault is locked/);
    expect(unreachable).toBeInstanceOf(VaultUnreachable);
  });

  it('waits only once per run, so a vault that keeps failing still ends the run', async() => {
    const vault = gate('unreachable', true);
    const operation = vi.fn(async() => { throw exitFault() });

    await expect(runWithCliFaultRecovery('Claude Code', operation, { canRetry: () => true, backoffMs: 0, vaultGate: vault }))
      .rejects.toBeInstanceOf(VaultUnreachable);
    expect(vault.waits).toBe(1);
  });

  it('leaves ordinary CLI faults unchanged when the vault was fine', async() => {
    await expect(runWithCliFaultRecovery('Claude Code', vi.fn(async() => { throw exitFault() }),
      { canRetry: () => true, backoffMs: 0, vaultGate: gate(undefined, true) })).rejects.toBeInstanceOf(CliRecoveryExhaustedError);
  });

  // risk: a vault problem marking the user's model as broken and prompting "Connect a model"
  it('classifies vault failures as Sulla-side, never as a provider sign-in problem', () => {
    const policy = new ModelRecoveryPolicy();

    for (const error of [new VaultLocked(), new Error('wrapped', { cause: new VaultUnreachable() })]) {
      const recovery = classifyLLMFailure(error);

      expect(recovery.kind).toBe('infrastructure');
      expect(recovery.userMessage).toMatch(/Password Vault/);
      expect(policy.canAdvance(recovery)).toBe(false);
    }
  });
});
