// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  ClientSessionService, RefreshOutcomeClassifier, RefreshSchedule,
  type CloudAccountTransport, type RefreshLock,
} from '@sulla/domain';
import { EventDispatcher, SystemClock, type Clock } from '@sulla/foundation';

import { DesktopRefreshLocks, NoListenerResolver, PendingEntryTokenStore } from './DesktopTokenStores';

/** The legacy `sulla-cloud` integration row Desktop stored before the container vault became the authority (keys as stored). */
export interface LegacyCloudSessionRow {
  user_id:               string;
  active_contractor_id?: string;
  /** May be missing in very old rows; only the refresh token is ever sent. */
  access_token?:         string;
  refresh_token:         string;
}

export type LegacyAdoptionOutcome =
  | { kind: 'rotated'; tokens: { accessToken: string; refreshToken: string } }
  /** Cloud answered 400/401/403: the legacy session is dead and the owner must sign in again. */
  | { kind: 'rejected' };

/**
 * Startup handoff of a legacy session into the container vault. A thin adapter: the row is wrapped in the existing
 * in-memory `PendingEntryTokenStore` and rotated once through the shared domain `ClientSessionService` (single flight
 * under the Desktop refresh lock; domain outcome rules: 400/401/403 reject, anything else is transient and throws the
 * domain `refresh_transient` error so the caller retries later). Nothing is written anywhere; the caller hands the
 * rotated pair to the vault.
 */
export class LegacyCloudSessionAdopter {
  /** Stands in for a missing legacy access token so the store can hold the session. Never sent: refresh only sends the refresh token. */
  static readonly NO_ACCESS_TOKEN = 'legacy-session-without-access-token';

  constructor(
    private readonly transport: CloudAccountTransport,
    private readonly lock: RefreshLock = DesktopRefreshLocks.shared,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async refresh(row: LegacyCloudSessionRow): Promise<LegacyAdoptionOutcome> {
    const store = new PendingEntryTokenStore({
      values: {
        user_id:              row.user_id,
        active_contractor_id: row.active_contractor_id || row.user_id,
        access_token:         row.access_token || LegacyCloudSessionAdopter.NO_ACCESS_TOKEN,
        refresh_token:        row.refresh_token,
      },
    });
    const sessions = new ClientSessionService(
      store, this.transport, this.lock, new RefreshSchedule(this.clock),
      new RefreshOutcomeClassifier(), new EventDispatcher(new NoListenerResolver()),
    );
    const seen = await store.read();
    if (!seen) return { kind: 'rejected' };
    const next = await sessions.refresh(seen);
    if (store.wasRejected() || !next) return { kind: 'rejected' };
    return { kind: 'rotated', tokens: { accessToken: next.tokens.accessToken, refreshToken: next.tokens.refreshToken } };
  }
}
