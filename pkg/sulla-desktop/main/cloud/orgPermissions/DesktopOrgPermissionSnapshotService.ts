// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SystemClock, type Clock } from '@sulla/foundation';
import {
  Authorizer,
  Bytes,
  NobleCryptoPrimitives,
  SnapshotFacts,
  SnapshotVerifier,
  type Action,
  type CryptoPrimitives,
  type Explanation,
  type PermissionSnapshot,
  type Principal,
  type ResourceRef,
  type SnapshotKey,
} from '@sulla/domain';

import type { OrgPermissionSnapshotStore } from './OrgPermissionSnapshotStore';
import type { OrgPermissionSnapshotTransport, PublishedSnapshotKey } from './OrgPermissionSnapshotTransport';

/** Whose authority a snapshot carries. */
export interface OrgSnapshotSubject {
  orgId:  string;
  userId: string;
}

export type SnapshotRefreshOutcome =
  | { kind: 'refreshed'; epoch: number }
  /** Cloud says this member or device lost access: the cached snapshot was dropped. */
  | { kind: 'revoked'; reason: 'not_member' | 'device_revoked' }
  /** Cloud couldn't be reached or couldn't sign; the cached snapshot (if any) is kept. */
  | { kind: 'offline'; detail: string }
  /** Cloud sent something that failed verification or rolled back the epoch; nothing was stored. */
  | { kind: 'rejected'; reason: string };

/** The verified snapshot a decision used, or why there is none. */
export type LoadedSnapshot =
  | { kind: 'verified'; snapshot: PermissionSnapshot }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

export interface DesktopOrgPermissionSnapshotDependencies {
  transport:       OrgPermissionSnapshotTransport;
  store:           OrgPermissionSnapshotStore;
  crypto?:         CryptoPrimitives;
  clock?:          Clock;
  /**
   * Keys shipped with the app. When set, only these keys are trusted and the published list is ignored; when
   * empty, Desktop trusts the keys Cloud publishes over TLS (cached for offline use).
   */
  pinnedKeys?:     readonly SnapshotKey[];
  /** This install's device id, so a snapshot that lists it as revoked is refused offline too. */
  deviceId?:       () => string | null;
  /** How old a cached snapshot may get before a decision tries to refresh it first. Default 15 minutes. */
  refreshAfterMs?: number;
}

/**
 * Desktop's offline org permissions (parity ledger: "Offline: verify Cloud's signed snapshot").
 *
 * Online, it fetches the member's Ed25519-signed `PermissionSnapshot` from Cloud (`GET /authz/snapshot?team=`) and
 * the published keys (`GET /authz/snapshot/keys`), verifies the snapshot with the domain `SnapshotVerifier`, and
 * caches the exact text. Offline, every decision re-verifies the cached text (signature, subject, window, expiry)
 * and answers through `new Authorizer(new SnapshotFacts(snapshot))`, which applies the domain's own freshness rule
 * (7 days, 24 h for sensitive verbs → `stale_snapshot` with `requiresLiveCheck`).
 *
 * Two checks the domain doesn't enforce yet (ledger F12) are applied here until it does:
 *   - epoch rollback: a snapshot older than the highest epoch already accepted for that member is refused;
 *   - device revocation: a snapshot that lists this device as revoked denies every decision.
 * A leaver or a revoked device loses offline access as soon as Cloud says so (404 / 403 device_revoked).
 * Cloud stays the authority for writes; this answers reads and pre-checks while Desktop is offline.
 */
export class DesktopOrgPermissionSnapshotService {
  static readonly DEFAULT_REFRESH_AFTER_MS = 15 * 60 * 1000;

  private readonly crypto: CryptoPrimitives;
  private readonly clock: Clock;
  private readonly refreshAfterMs: number;
  private readonly inFlight = new Map<string, Promise<SnapshotRefreshOutcome>>();

  constructor(private readonly deps: DesktopOrgPermissionSnapshotDependencies) {
    this.crypto = deps.crypto ?? new NobleCryptoPrimitives();
    this.clock = deps.clock ?? new SystemClock();
    this.refreshAfterMs = deps.refreshAfterMs ?? DesktopOrgPermissionSnapshotService.DEFAULT_REFRESH_AFTER_MS;
  }

  /** Fetch, verify and cache the member's snapshot. Concurrent calls for one member share one request. */
  refresh(subject: OrgSnapshotSubject): Promise<SnapshotRefreshOutcome> {
    const key = JSON.stringify([subject.orgId, subject.userId]);
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.refreshNow(subject).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);

    return work;
  }

  /** The cached snapshot, verified now. Never touches the network. */
  load(subject: OrgSnapshotSubject): LoadedSnapshot {
    const entry = this.deps.store.entry(subject.orgId, subject.userId);
    if (!entry.snapshot) return { kind: 'missing' };
    const verified = this.verify(entry.snapshot.text, subject);
    if (verified.kind !== 'verified') return verified;
    if (verified.snapshot.epoch < entry.highWaterEpoch) return { kind: 'invalid', reason: 'rolled_back' };

    return verified;
  }

  /** An Authorizer that answers from the verified cached snapshot, or null when there is none. */
  authorizerFor(subject: OrgSnapshotSubject): Authorizer | null {
    const loaded = this.load(subject);

    return loaded.kind === 'verified' ? new Authorizer(new SnapshotFacts(loaded.snapshot), this.clock) : null;
  }

  /**
   * `can()` for an org decision. Refreshes first when online and the cache is missing or older than
   * `refreshAfterMs`; a failed refresh falls back to the cached snapshot. Without a valid snapshot the answer is a
   * denial with `requiresLiveCheck` (the domain's "go online and ask again").
   */
  async can(principal: Principal, action: Action, resource: ResourceRef): Promise<Explanation> {
    const subject = this.subjectOf(principal);
    if (!subject) return this.unavailable('unknown_principal', 'snapshot:no-member-subject');

    if (this.needsRefresh(subject)) await this.refresh(subject);

    const loaded = this.load(subject);
    if (loaded.kind !== 'verified') return this.unavailable('stale_snapshot', `snapshot:${ loaded.kind === 'missing' ? 'missing' : loaded.reason }`);

    const facts = new SnapshotFacts(loaded.snapshot);
    const deviceId = this.deps.deviceId?.() ?? null;
    if (deviceId && facts.isDeviceRevoked(deviceId)) return this.unavailable('scope_not_allowed', 'snapshot:device-revoked', false);

    return new Authorizer(facts, this.clock).can(principal, action, resource);
  }

  private async refreshNow(subject: OrgSnapshotSubject): Promise<SnapshotRefreshOutcome> {
    const fetched = await this.deps.transport.fetchSnapshot(subject.orgId);
    if (fetched.kind === 'not_member' || fetched.kind === 'device_revoked') {
      this.deps.store.dropSnapshot(subject.orgId, subject.userId);

      return { kind: 'revoked', reason: fetched.kind };
    }
    if (fetched.kind === 'unavailable') return { kind: 'offline', detail: fetched.detail };

    let verified = this.verify(fetched.text, subject);
    if (verified.kind !== 'verified' && verified.reason === 'unknown_key' && !this.pinned()) {
      // Cloud may have rotated to a key we haven't cached yet.
      if (await this.refreshKeys()) verified = this.verify(fetched.text, subject);
    }
    if (verified.kind !== 'verified') return { kind: 'rejected', reason: verified.reason };

    const { highWaterEpoch } = this.deps.store.entry(subject.orgId, subject.userId);
    if (verified.snapshot.epoch < highWaterEpoch) return { kind: 'rejected', reason: 'rolled_back' };

    this.deps.store.saveSnapshot(subject.orgId, subject.userId, { text: fetched.text, fetchedAt: this.clock.now().toISOString() }, verified.snapshot.epoch);

    return { kind: 'refreshed', epoch: verified.snapshot.epoch };
  }

  private verify(text: string, subject: OrgSnapshotSubject): { kind: 'verified'; snapshot: PermissionSnapshot } | { kind: 'invalid'; reason: string } {
    const keys = this.trustedKeys();
    if (keys.length === 0) return { kind: 'invalid', reason: 'unknown_key' };
    try {
      const { snapshot } = new SnapshotVerifier(this.crypto, keys, this.clock).verify(text, subject);

      return { kind: 'verified', snapshot };
    } catch (error) {
      const reason = (error as { reason?: unknown })?.reason;

      return { kind: 'invalid', reason: typeof reason === 'string' ? reason : 'invalid_snapshot' };
    }
  }

  private trustedKeys(): SnapshotKey[] {
    if (this.pinned()) return [...(this.deps.pinnedKeys ?? [])];

    return this.deps.store.keys().flatMap((k) => this.toSnapshotKey(k));
  }

  private pinned(): boolean {
    return (this.deps.pinnedKeys?.length ?? 0) > 0;
  }

  private async refreshKeys(): Promise<boolean> {
    const keys = await this.deps.transport.fetchKeys();
    if (!keys) return false;
    this.deps.store.saveKeys(keys);

    return true;
  }

  private toSnapshotKey(key: PublishedSnapshotKey): SnapshotKey[] {
    try {
      const activeFrom = new Date(key.activeFrom);
      const retiredAt = key.retiredAt ? new Date(key.retiredAt) : null;
      if (Number.isNaN(activeFrom.getTime()) || (retiredAt && Number.isNaN(retiredAt.getTime()))) return [];

      return [{ keyId: key.keyId, publicKey: Bytes.fromBase64Url(key.publicKey), activeFrom, retiredAt }];
    } catch {
      return [];
    }
  }

  private needsRefresh(subject: OrgSnapshotSubject): boolean {
    const { snapshot } = this.deps.store.entry(subject.orgId, subject.userId);
    if (!snapshot) return true;
    const fetchedAt = Date.parse(snapshot.fetchedAt);

    return !Number.isFinite(fetchedAt) || this.clock.now().getTime() - fetchedAt >= this.refreshAfterMs;
  }

  /** The member whose snapshot answers for this principal; agents, devices and services ride on their human. */
  private subjectOf(principal: Principal): OrgSnapshotSubject | null {
    switch (principal.kind) {
    case 'user':
    case 'device':
      return { orgId: principal.orgId, userId: principal.userId };
    case 'agent':
      return { orgId: principal.actingFor.orgId, userId: principal.actingFor.userId };
    case 'service':
      return principal.actingFor ? { orgId: principal.actingFor.orgId, userId: principal.actingFor.userId } : null;
    default:
      // Platform (super-admin) decisions are Cloud-only.
      return null;
    }
  }

  private unavailable(reason: Explanation['reason'], step: string, requiresLiveCheck = true): Explanation {
    return {
      allowed: false, reason, via: 'none', path: [step], effectiveLevel: 'none', requiredLevel: 'none',
      requiresApproval: false, requiresStepUp: false, requiresLiveCheck, audit: false,
    };
  }
}
