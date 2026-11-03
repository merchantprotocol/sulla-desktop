// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Electron main → vault container calls for Passwords sync v3. Uses the
 * approval service identity over the pinned local TLS session, the same
 * caller that already relays Sulla Cloud requests through the container.
 *
 * Responses carry handles, hashes, counts and status only. Main never asks
 * for, and the container never returns, a sync body, a key or plaintext.
 */

import { loadDesktopApprovalIdentity, desktopVaultFetch } from '@pkg/vault-broker/desktopTransport';
import { loopbackOrigin } from '@pkg/utils/instance';

// Same endpoint as @pkg/vault-broker's DESKTOP_VAULT_ENDPOINT.
const DESKTOP_VAULT_ENDPOINT = loopbackOrigin('https', 30135);

export type SyncOp = 'enable' | 'replace' | 'commit' | 'rewrap' | 'pause' | 'resume' | 'delete';

export interface PreparedSync { handle: string; sha256: string; vaultId: string; op: string }

export interface LocalSyncStatus {
  configured:           boolean;
  vaultId?:             string;
  headSeq?:             number;
  lastPushAt?:          string | null;
  lastPullAt?:          string | null;
  lastError?:           string | null;
  policyReviewPending?: number;
  pendingChanges?:      number;
  bundleStale?:         boolean;
}

export class ContainerSyncError extends Error {
  constructor(public readonly code: string, public readonly status: number, message?: string) {
    super(message || code);
  }
}

async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const identity = await loadDesktopApprovalIdentity();
  const response = await desktopVaultFetch(`${ DESKTOP_VAULT_ENDPOINT }/v1/desktop/cloud-sync/${ path }`, {
    method:  'POST',
    headers: {
      authorization:        `Bearer ${ identity.serviceToken }`,
      'content-type':       'application/json',
      'x-sulla-service-id': identity.serviceId,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new ContainerSyncError(String(payload.error || `http_${ response.status }`), response.status, payload.message);
  return payload as T;
}

export const VaultSyncContainer = {
  status: () => call<LocalSyncStatus>('status'),
  pull:   (deviceId: string) => call<{ applied: number; conflictCopies: number; headSeq: number; syncPaused?: boolean; cloudMissing?: boolean }>('pull', { deviceId }),
  prepare: (op: SyncOp, deviceId: string) => call<PreparedSync | { idle: true }>('prepare', { op, deviceId }),
  send:   (handle: string, ts: number, signature: string) => call<{ ok: boolean; status: number; error?: string; detail?: any }>('send', { handle, ts, signature }),
  forget: () => call<{ ok: true }>('forget'),
};
