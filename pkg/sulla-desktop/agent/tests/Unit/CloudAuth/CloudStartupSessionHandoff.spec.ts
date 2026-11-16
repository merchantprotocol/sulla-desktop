// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { VaultNotReadyError } from '../../../../main/cloud/session/CloudSessionStartupRestorer';
import { CloudStartupSessionHandoff, type CloudStartupSessionHandoffPorts } from '../../../../main/cloud/session/CloudStartupSessionHandoff';
import type { CloudSessionRepository } from '../../../../main/cloud/session/CloudSessionRepository';
import type { LegacyAdoptionOutcome, LegacyCloudSessionAdopter } from '../../../../main/cloud/session/LegacyCloudSessionAdopter';

const USER = 'user-0001';

class InvalidOperation extends Error {}

function harness(options: {
  metadata?: { activeAccountId?: string; accounts: Array<{ accountId: string; active?: boolean; connected: boolean }> };
  legacy?: Record<string, string> | null;
  adoption?: LegacyAdoptionOutcome | Error;
  adoptError?: Error;
  containerVault?: boolean;
} = {}) {
  const adoptSullaCloudSession = vi.fn(async(_: unknown) => { if (options.adoptError) throw options.adoptError; });
  const deleteLegacyIntegrationSession = vi.fn(async() => {});
  const clearLegacySettings = vi.fn(async() => {});
  const refresh = vi.fn(async() => {
    if (options.adoption instanceof Error) throw options.adoption;
    return options.adoption ?? { kind: 'rotated', tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' } };
  });
  const integrationMetadata = vi.fn(async() => options.metadata ?? { accounts: [] });
  const ports: CloudStartupSessionHandoffPorts = {
    usesContainerVault:             () => options.containerVault ?? true,
    credentialBroker:               () => ({ status: async() => ({ unlocked: true }), integrationMetadata }) as any,
    approvalClient:                 () => ({ adoptSullaCloudSession }) as any,
    findLegacyIntegrationSession:   async() => options.legacy === undefined ? null : options.legacy,
    deleteLegacyIntegrationSession,
    isInvalidOperation:             error => error instanceof InvalidOperation,
    logger:                         { log: vi.fn() },
  };
  const sessions = { clearLegacySettings, hasPending: () => false, loadIdentity: vi.fn(async() => null) } as unknown as CloudSessionRepository;
  const handoff = new CloudStartupSessionHandoff(sessions, { refresh } as unknown as LegacyCloudSessionAdopter, ports);
  return { handoff, adoptSullaCloudSession, deleteLegacyIntegrationSession, clearLegacySettings, refresh, integrationMetadata };
}

describe('CloudStartupSessionHandoff legacy adoption', () => {
  const legacyRow = { user_id: USER, active_contractor_id: USER, access_token: 'old-access', refresh_token: 'old-refresh', contractors_json: '[]' };

  it('risk: session lost. rotates the legacy session once and hands the new pair to the vault, then deletes the legacy copy', async() => {
    const h = harness({ legacy: legacyRow });

    await h.handoff.ensureLegacySessionAdopted();

    expect(h.refresh).toHaveBeenCalledWith({ user_id: USER, active_contractor_id: USER, access_token: 'old-access', refresh_token: 'old-refresh' });
    expect(h.adoptSullaCloudSession).toHaveBeenCalledWith({
      userId: USER, activeContractorId: USER, contractors: [], accessToken: 'new-access', refreshToken: 'new-refresh',
    });
    expect(h.deleteLegacyIntegrationSession).toHaveBeenCalledTimes(1);
    expect(h.clearLegacySettings).toHaveBeenCalledTimes(1);
    expect(h.handoff.lastError()).toBeUndefined();

    // Done for this process: a second call does nothing.
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('risk: duplicate token rotation. concurrent callers share one adoption', async() => {
    const h = harness({ legacy: legacyRow });
    await Promise.all([h.handoff.ensureLegacySessionAdopted(), h.handoff.ensureLegacySessionAdopted()]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('risk: stale copy kept. a vault that already has the account only deletes the legacy copy', async() => {
    const h = harness({ metadata: { activeAccountId: USER, accounts: [{ accountId: USER, connected: true }] }, legacy: legacyRow });
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.deleteLegacyIntegrationSession).toHaveBeenCalledTimes(1);
  });

  it('risk: dead session shown as signed in. a rejected refresh asks the owner to sign in again', async() => {
    const h = harness({ legacy: legacyRow, adoption: { kind: 'rejected' } });
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.adoptSullaCloudSession).not.toHaveBeenCalled();
    expect(h.handoff.lastError()).toBe(CloudStartupSessionHandoff.SIGN_IN_AGAIN);
  });

  it('risk: dead session shown as signed in. a row without a refresh token asks the owner to sign in again', async() => {
    const h = harness({ legacy: { user_id: USER, refresh_token: '' } });
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.handoff.lastError()).toBe('Sign in to Sulla Cloud again.');
  });

  it('risk: startup gives up early. a transient refresh failure is retryable and does not finish the handoff', async() => {
    const h = harness({ legacy: legacyRow, adoption: new Error('network down') });
    await expect(h.handoff.ensureLegacySessionAdopted()).rejects.toBeInstanceOf(VaultNotReadyError);
    await expect(h.handoff.ensureLegacySessionAdopted()).rejects.toThrow('cloud refresh unavailable: network down');
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('risk: dead session shown as signed in. a vault that refuses adoption asks the owner to sign in again', async() => {
    const h = harness({ legacy: legacyRow, adoptError: new InvalidOperation('nope') });
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.deleteLegacyIntegrationSession).not.toHaveBeenCalled();
    expect(h.handoff.lastError()).toBe(CloudStartupSessionHandoff.SIGN_IN_AGAIN);
  });

  it('risk: wrong storage. server mode never adopts into the container vault', async() => {
    const h = harness({ legacy: legacyRow, containerVault: false });
    await h.handoff.ensureLegacySessionAdopted();
    expect(h.integrationMetadata).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
