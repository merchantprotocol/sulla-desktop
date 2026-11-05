// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Typed HTTP boundary for Cloud vault-sync v3. It contains no sync policy. */

export type VaultSyncErrorCode =
  | 'invalid_body' | 'invalid_query' | 'too_large' | 'unauthorized' | 'session_expired'
  | 'device_signature_required' | 'forbidden_origin' | 'vault_access_not_approved'
  | 'vault_principal_not_trusted' | 'reauth_required' | 'owner_required' | 'not_found'
  | 'vault_exists' | 'recovery_required' | 'already_trusted' | 'head_stale'
  | 'record_conflict' | 'sync_paused' | 'vault_locked' | 'password_kdf_missing'
  | 'device_revoked' | 'integrity_failed' | 'invalid_proof' | 'handle_stale' | 'handle_expired'
  | (string & {});

export interface VaultSyncHttpClient {
  request(url: string, init?: RequestInit): Promise<Response>;
}
export type VaultSyncAuthHeaderProvider = () => Promise<Record<string, string>> | Record<string, string>;
export interface VaultSyncSignature { deviceId: string; timestamp: number; signature: string }
export interface VaultStatus { enabled?: boolean; vaultId?: string; epoch?: number; [key: string]: unknown }
export type EnrollmentStateName = 'no_vault' | 'trusted' | 'approval_available' | 'waiting_for_approver' | 'recovery_required';
export interface EnrollmentState { state: EnrollmentStateName; vaultId?: string; epoch?: number }
export interface EnrollmentRequest {
  id: string;
  vaultId?: string;
  epoch?: number;
  requesterType: string;
  requesterId: string;
  publicKey: string;
  nonce: string;
  expiresAt: string;
}
export interface VaultBundleResponse { bundle?: Record<string, unknown>; [key: string]: unknown }
export interface VaultRecordsResponse { records?: unknown[]; head?: unknown; nextCursor?: string | null; syncPaused?: boolean; bundleGeneration?: number; epoch?: number; [key: string]: unknown }
export interface VaultAuditResponse { audit?: unknown[]; nextCursor?: string | null; [key: string]: unknown }

export class VaultSyncHttpError extends Error {
  constructor(public readonly code: VaultSyncErrorCode, public readonly status: number) {
    super(code);
    this.name = 'VaultSyncHttpError';
  }
}

export class VaultSyncErrorMapper {
  map(status: number, body: unknown): VaultSyncHttpError {
    const code = typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : status === 423 ? 'vault_locked' : `http_${status}`;
    return new VaultSyncHttpError(code, status);
  }
}

export interface VaultSyncTransportOptions {
  client: VaultSyncHttpClient;
  authHeaders: VaultSyncAuthHeaderProvider;
  baseUrl?: string;
  errorMapper?: VaultSyncErrorMapper;
  maxResponseBytes?: number;
  maxLargeResponseBytes?: number;
}

export class CloudVaultSyncHttpTransport {
  private readonly maxResponseBytes: number;
  private readonly maxLargeResponseBytes: number;
  private readonly mapper: VaultSyncErrorMapper;
  constructor(private readonly options: VaultSyncTransportOptions) {
    this.mapper = options.errorMapper ?? new VaultSyncErrorMapper();
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.maxLargeResponseBytes = options.maxLargeResponseBytes ?? 40 * 1024 * 1024;
  }

  getStatus(deviceId: string): Promise<VaultStatus> { return this.json('GET', `/cloud-vault-sync/status?deviceId=${encodeURIComponent(deviceId)}`); }
  getEnrollmentState(vaultId: string, signature: VaultSyncSignature): Promise<EnrollmentState> {
    return this.signed('GET', '/cloud-vault-sync/enrollment/state', vaultId, 'enrollment-state', signature);
  }
  listEnrollmentRequests(vaultId: string, signature: VaultSyncSignature): Promise<{ requests?: EnrollmentRequest[] }> {
    return this.signed('GET', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests`, vaultId, 'enrollment-list', signature);
  }
  openEnrollmentRequest(vaultId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<EnrollmentRequest> {
    return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests`, vaultId, 'enrollment-request', signature, body);
  }
  consumeEnrollmentRequest(vaultId: string, requestId: string, signature: VaultSyncSignature): Promise<{ wrappedUserKey: unknown }> {
    return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests/${encodeURIComponent(requestId)}/consume`, vaultId, `enrollment-consume:${requestId}`, signature, {});
  }
  confirmEnrollmentRequest(vaultId: string, requestId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> {
    return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests/${encodeURIComponent(requestId)}/confirm`, vaultId, `enrollment-confirm:${requestId}`, signature, body);
  }
  respondToEnrollmentRequest(vaultId: string, requestId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> {
    return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests/${encodeURIComponent(requestId)}/respond`, vaultId, `enrollment-respond:${requestId}`, signature, body);
  }
  getBundle(vaultId: string, deviceId: string): Promise<VaultBundleResponse> { return this.json('GET', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/bundle?deviceId=${encodeURIComponent(deviceId)}`, undefined, {}, this.maxLargeResponseBytes); }
  getRecords(vaultId: string, deviceId: string, scope = 'personal', since?: number, cursor?: string, limit?: number): Promise<VaultRecordsResponse> {
    const query = new URLSearchParams({ scope, deviceId });
    if (since !== undefined) query.set('since', String(since)); if (cursor) query.set('cursor', cursor); if (limit !== undefined) query.set('limit', String(limit));
    return this.json('GET', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/records?${query}`, undefined, {}, this.maxLargeResponseBytes);
  }
  commit(vaultId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/commit`, vaultId, 'commit', signature, body); }
  pause(vaultId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/pause`, vaultId, 'pause', signature, body); }
  resume(vaultId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/resume`, vaultId, 'resume', signature, body); }
  restoreBundle(vaultId: string, body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('POST', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/restore-bundle`, vaultId, 'restore-bundle', signature, body); }
  audit(vaultId: string, deviceId: string, cursor?: string): Promise<VaultAuditResponse> { return this.json('GET', `/cloud-vault-sync/audit?vaultId=${encodeURIComponent(vaultId)}&deviceId=${encodeURIComponent(deviceId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); }
  upsertVault(vaultId: string, operation: 'create' | 'replace' | 'rewrap', body: Record<string, unknown>, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('PUT', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}?op=${operation}`, vaultId, operation, signature, body); }
  deleteVault(vaultId: string, signature: VaultSyncSignature): Promise<Record<string, unknown>> { return this.signed('DELETE', `/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}`, vaultId, 'delete', signature); }

  private async signed(method: string, path: string, vaultId: string, operation: string, signature: VaultSyncSignature, body?: Record<string, unknown>): Promise<any> {
    const separator = path.includes('?') ? '&' : '?';
    return this.json(method, `${path}${separator}deviceId=${encodeURIComponent(signature.deviceId)}`, body, {
      'X-Sulla-Timestamp': String(signature.timestamp), 'X-Sulla-Device-Signature': signature.signature,
    });
  }
  private async json<T>(method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}, maxResponseBytes = this.maxResponseBytes): Promise<T> {
    const merged = { ...(await this.options.authHeaders()), ...headers };
    if (body !== undefined) merged['Content-Type'] = 'application/json';
    const response = await this.options.client.request(`${this.options.baseUrl ?? ''}${path}`, { method, headers: merged, body: body === undefined ? undefined : JSON.stringify(body) });
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maxResponseBytes) throw this.mapper.map(413, { code: 'too_large' });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw this.mapper.map(413, { code: 'too_large' });
    let payload: unknown = null;
    if (text) { try { payload = JSON.parse(text); } catch { if (!response.ok) throw this.mapper.map(response.status, null); throw this.mapper.map(502, { code: 'invalid_body' }); } }
    if (!response.ok) throw this.mapper.map(response.status, payload);
    return payload as T;
  }
}
