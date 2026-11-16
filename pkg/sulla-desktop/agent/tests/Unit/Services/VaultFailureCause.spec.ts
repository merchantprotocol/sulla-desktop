// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { VaultHealthMonitor } from '../../../../vault-broker/vaultHealth';
import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';
import { CliFaultError, CliRecoveryExhaustedError, runWithCliFaultRecovery } from '../../../languagemodels/cliFaultRecovery';
import { VaultLocked, VaultUnreachable } from '../../../languagemodels/failures';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';
import { VaultAvailabilityGate } from '../../../languagemodels/vaultGate';

import type { VaultGate } from '../../../languagemodels/vaultGate';

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
    expect(VaultHealthMonitor.failureKind(423, undefined)).toBe('locked');
    expect(VaultHealthMonitor.failureKind(502, 'vault_locked')).toBe('locked');
    expect(VaultHealthMonitor.failureKind(503, 'vault_unreachable_ERR_INSUFFICIENT_RESOURCES')).toBe('unreachable');
    expect(VaultHealthMonitor.failureKind(503, 'vault_starting')).toBe('unreachable');
    expect(VaultHealthMonitor.failureKind(502, 'upstream_failed')).toBeUndefined();
  });

  it('only reports refusals from the current run window and clears on success', () => {
    const health = new VaultHealthMonitor();

    health.record('locked', 1_000);
    expect(health.failureSince(500)).toBe('locked');
    expect(health.failureSince(2_000)).toBeUndefined();
    health.recordSuccess();
    expect(health.failureSince(0)).toBeUndefined();
  });

  it('counts a refusal recorded exactly at the run start and keeps only the latest one', () => {
    const health = new VaultHealthMonitor();

    health.record('unreachable', 1_000);
    expect(health.failureSince(1_000)).toBe('unreachable');
    expect(health.failureSince(1_001)).toBeUndefined();
    health.record('locked', 3_000);
    expect(health.failureSince(1_000)).toBe('locked');
  });

  // risk: one run's vault refusal leaking into an unrelated monitor's state
  it('keeps state per monitor instance', () => {
    const first = new VaultHealthMonitor();
    const second = new VaultHealthMonitor();

    first.record('locked', 1_000);
    expect(second.failureSince(0)).toBeUndefined();
    second.recordSuccess();
    expect(first.failureSince(0)).toBe('locked');
  });
});

describe('VaultAvailabilityGate', () => {
  // risk: a run that never resumes after the user unlocks the vault
  it('returns true and clears the recorded failure once the probe reports unlocked', async() => {
    const health = new VaultHealthMonitor();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const gate = new VaultAvailabilityGate(health, 1_000, 1, probe);

    health.record('locked', 0);
    expect(gate.failureSince(0)).toBe('locked');
    await expect(gate.waitUntilAvailable()).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(health.failureSince(0)).toBeUndefined();
  });

  // risk: a run waiting forever on a vault that never comes back
  it('returns false after the deadline and keeps the failure', async() => {
    const health = new VaultHealthMonitor();
    const gate = new VaultAvailabilityGate(health, 5, 1, async() => false);

    health.record('unreachable', 0);
    await expect(gate.waitUntilAvailable()).resolves.toBe(false);
    expect(health.failureSince(0)).toBe('unreachable');
  });

  it('returns false without probing when the run is already aborted', async() => {
    const probe = vi.fn(async() => true);
    const gate = new VaultAvailabilityGate(new VaultHealthMonitor(), 1_000, 1, probe);

    await expect(gate.waitUntilAvailable(AbortSignal.abort())).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('stops polling when the run is aborted mid-wait', async() => {
    const controller = new AbortController();
    const probe = vi.fn(async() => {
      controller.abort();

      return false;
    });
    const gate = new VaultAvailabilityGate(new VaultHealthMonitor(), 60_000, 1, probe);

    await expect(gate.waitUntilAvailable(controller.signal)).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
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
