// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** A Cloud signing key as `GET /authz/snapshot/keys` publishes it (publicKey is base64url). */
export interface PublishedSnapshotKey {
  keyId:      string;
  publicKey:  string;
  activeFrom: string;
  retiredAt:  string | null;
}

/** What Cloud said about one member's snapshot. */
export type SnapshotFetchResult =
  | { kind: 'snapshot'; text: string }
  /** 404: not a member of that org (left, removed, org deleted). Offline access must end. */
  | { kind: 'not_member' }
  /** 403 device_revoked: this device was revoked. Offline access must end. */
  | { kind: 'device_revoked' }
  /** Cloud couldn't answer now (offline, 5xx, 401, signing key not configured). Keep what we have. */
  | { kind: 'unavailable'; detail: string };

/** Port to Cloud's offline-permission endpoints (sulla-workers src/routes/authz-snapshot.ts). */
export interface OrgPermissionSnapshotTransport {
  fetchSnapshot(orgId: string): Promise<SnapshotFetchResult>;
  /** The published verification keys, or null when Cloud can't be reached. */
  fetchKeys(): Promise<PublishedSnapshotKey[] | null>;
}

/** Desktop's signed-in Cloud request (main/cloud/cloudFetch.ts `cloudRequest`), injected so tests use a fake. */
export type CloudRequest = (method: string, path: string, options?: { headers?: Record<string, string>; responseType?: 'json' | 'text' }) => Promise<Response>;

/** `OrgPermissionSnapshotTransport` over Desktop's signed-in Cloud session. */
export class CloudOrgPermissionSnapshotTransport implements OrgPermissionSnapshotTransport {
  static readonly SNAPSHOT_PATH = '/authz/snapshot';
  static readonly KEYS_PATH = '/authz/snapshot/keys';

  constructor(private readonly request: CloudRequest) {}

  async fetchSnapshot(orgId: string): Promise<SnapshotFetchResult> {
    let response: Response;
    try {
      response = await this.request('GET', `${ CloudOrgPermissionSnapshotTransport.SNAPSHOT_PATH }?team=${ encodeURIComponent(orgId) }`, { responseType: 'text' });
    } catch (error) {
      return { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
    const text = await response.text();
    if (response.status === 200) return { kind: 'snapshot', text };
    if (response.status === 404) return { kind: 'not_member' };
    if (response.status === 403 && this.reason(text) === 'device_revoked') return { kind: 'device_revoked' };

    return { kind: 'unavailable', detail: `HTTP ${ response.status }` };
  }

  async fetchKeys(): Promise<PublishedSnapshotKey[] | null> {
    try {
      const response = await this.request('GET', CloudOrgPermissionSnapshotTransport.KEYS_PATH, { responseType: 'text' });
      if (response.status !== 200) return null;
      const body = JSON.parse(await response.text()) as { keys?: unknown };

      return Array.isArray(body.keys) ? body.keys.filter((k): k is PublishedSnapshotKey => this.isKey(k)) : null;
    } catch {
      return null;
    }
  }

  private reason(text: string): string | undefined {
    try {
      const body = JSON.parse(text) as { reason?: unknown };

      return typeof body?.reason === 'string' ? body.reason : undefined;
    } catch {
      return undefined;
    }
  }

  private isKey(value: unknown): boolean {
    const k = value as Partial<PublishedSnapshotKey> | null;

    return !!k && typeof k.keyId === 'string' && typeof k.publicKey === 'string' && typeof k.activeFrom === 'string' &&
      (k.retiredAt === null || typeof k.retiredAt === 'string');
  }
}
