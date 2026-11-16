// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServerDeviceSigner, Sleeper } from './ServerDeviceSigner';

/** The canonical prefix the server signs paths under (sulla-server `DESKTOP_API_PATH`). */
export const DESKTOP_API_PATH = '/desktop/v1';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** A non-2xx answer from the server; `code` is its `{error}` field (e.g. `stale_device_proof`, `device_id_in_use`). */
export class ServerEnrollmentError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Sulla Server answered ${ status }: ${ code }`);
    this.name = 'ServerEnrollmentError';
  }
}

export type EnrollmentStatus = 'pending' | 'approved' | 'denied' | 'expired' | string;

export interface SubmittedEnrollment {
  enrollmentId: string;
  status: EnrollmentStatus;
  expiresAt: string;
  /** Bearer for `poll`; never a device credential. */
  pollToken: string;
}

export interface EnrollmentState {
  enrollmentId: string;
  status: EnrollmentStatus;
  expiresAt: string;
  /** The server's device row id, present once approved; every signed call addresses it. */
  serverDeviceId: string | null;
}

export interface EnrollOptions {
  metadata?: Record<string, unknown>;
  /** Re-enrolling an already enrolled device id with a new key: a `keyRotationProof` signed by the enrolled key. */
  rotationProof?: { ts: number; signature: string };
}

/**
 * Sulla Server `/desktop/v1` client: device-proof enrollment, approval polling, and the signed device calls (heartbeat,
 * audience token, relay ticket, key rotation, removal). Every signed call sends the exact JSON bytes it signed.
 *
 * `desktopApi` is the `desktopApi` URL from the server's `/.well-known/sulla-server` document.
 */
export class ServerEnrollmentClient {
  static readonly POLL_INTERVAL_MS = 3000;

  private readonly baseUrl: string;

  constructor(desktopApi: string, private readonly signer: ServerDeviceSigner, private readonly fetch: FetchLike, private readonly sleep: Sleeper = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    const url = new URL(desktopApi);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('desktopApi must be an http(s) URL');
    this.baseUrl = url.href.replace(/\/+$/, '');
  }

  /** Submits a pending enrollment for admin approval. `bearer` is a hosted access token for `sulla-desktop-enrollment`. */
  async enroll(bearer: string, organizationId: string, options: EnrollOptions = {}): Promise<SubmittedEnrollment> {
    const { deviceId, publicKey, proof } = await this.signer.enrollmentProof(organizationId);
    const body: Record<string, unknown> = { organizationId, deviceId, publicKey, proof };
    if (options.metadata) body.metadata = options.metadata;
    if (options.rotationProof) body.rotationProof = options.rotationProof;
    const answer = await this.send('POST', '/enrollments', JSON.stringify(body), { authorization: `Bearer ${ bearer }` });
    const enrollment = ServerEnrollmentClient.record(answer.enrollment);

    return {
      enrollmentId: ServerEnrollmentClient.text(enrollment.id),
      status:       ServerEnrollmentClient.text(enrollment.status),
      expiresAt:    ServerEnrollmentClient.text(enrollment.expires_at),
      pollToken:    ServerEnrollmentClient.text(answer.pollToken),
    };
  }

  async poll(enrollmentId: string, pollToken: string): Promise<EnrollmentState> {
    const answer = await this.send('GET', `/enrollments/${ ServerEnrollmentClient.segment(enrollmentId) }`, undefined, { authorization: `Bearer ${ pollToken }` });
    const device = answer.device === undefined ? null : ServerEnrollmentClient.record(answer.device);

    return {
      enrollmentId: ServerEnrollmentClient.text(answer.id),
      status:       ServerEnrollmentClient.text(answer.status),
      expiresAt:    ServerEnrollmentClient.text(answer.expiresAt),
      serverDeviceId: device ? ServerEnrollmentClient.text(device.id) : null,
    };
  }

  /**
   * Polls until the enrollment leaves `pending` or `maxAttempts` run out. `approved` without a `serverDeviceId` means the
   * approved device is no longer active with this key (revoked or replaced): it is final too, and the caller re-enrolls.
   */
  async waitForDecision(enrollmentId: string, pollToken: string, maxAttempts = 200, intervalMs = ServerEnrollmentClient.POLL_INTERVAL_MS): Promise<EnrollmentState> {
    let state = await this.poll(enrollmentId, pollToken);
    for (let attempt = 1; attempt < maxAttempts && ServerEnrollmentClient.undecided(state); attempt++) {
      await this.sleep(intervalMs);
      state = await this.poll(enrollmentId, pollToken);
    }

    return state;
  }

  async heartbeat(serverDeviceId: string, metadata?: Record<string, unknown>): Promise<{ serverTime: string }> {
    const answer = await this.signed('POST', `/devices/${ ServerEnrollmentClient.segment(serverDeviceId) }/heartbeat`, metadata ? { metadata } : {});

    return { serverTime: ServerEnrollmentClient.text(answer.serverTime) };
  }

  /** A short-lived server token for one resource audience (e.g. `sulla-vault`). */
  async audienceToken(serverDeviceId: string, audience: string): Promise<{ token: string; expiresIn: number; audience: string }> {
    const answer = await this.signed('POST', `/devices/${ ServerEnrollmentClient.segment(serverDeviceId) }/token`, { audience });
    if (typeof answer.expiresIn !== 'number') throw new ServerEnrollmentError(502, 'malformed_response');

    return { token: ServerEnrollmentClient.text(answer.token), expiresIn: answer.expiresIn, audience: ServerEnrollmentClient.text(answer.audience) };
  }

  async relayTicket(serverDeviceId: string): Promise<{ token: string; expiresAt: string }> {
    const answer = await this.signed('POST', `/devices/${ ServerEnrollmentClient.segment(serverDeviceId) }/tickets/relay`, {});

    return { token: ServerEnrollmentClient.text(answer.token), expiresAt: ServerEnrollmentClient.text(answer.expiresAt) };
  }

  /**
   * Moves the enrolled device to `nextPublicKey`. The call is signed by the current key and carries the current key's
   * rotation proof; `userId` is the account subject the device is enrolled under. The old key stops working at once.
   */
  async rotateKey(serverDeviceId: string, userId: string, nextPublicKey: string): Promise<{ publicKey: string }> {
    const proof = await this.signer.keyRotationProof(userId, nextPublicKey);
    const answer = await this.signed('POST', `/devices/${ ServerEnrollmentClient.segment(serverDeviceId) }/key`, { publicKey: nextPublicKey, proof });

    return { publicKey: ServerEnrollmentClient.text(ServerEnrollmentClient.record(answer.device).publicKey) };
  }

  /** Removes this device from the server (it revokes itself). */
  async remove(serverDeviceId: string): Promise<void> {
    await this.signed('DELETE', `/devices/${ ServerEnrollmentClient.segment(serverDeviceId) }`, undefined);
  }

  private async signed(method: string, action: string, body: unknown): Promise<Record<string, unknown>> {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers = await this.signer.requestHeaders(method, `${ DESKTOP_API_PATH }${ action }`, rawBody);

    return this.send(method, action, body === undefined ? undefined : rawBody, { ...headers });
  }

  private async send(method: string, action: string, rawBody: string | undefined, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${ this.baseUrl }${ action }`, {
      method,
      headers: rawBody === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(rawBody === undefined ? {} : { body: rawBody }),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = null }
    if (response.status < 200 || response.status > 299) {
      const code = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : 'http_error';
      throw new ServerEnrollmentError(response.status, code);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ServerEnrollmentError(502, 'malformed_response');

    return parsed as Record<string, unknown>;
  }

  private static undecided(state: EnrollmentState): boolean {
    return state.status === 'pending';
  }

  private static record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServerEnrollmentError(502, 'malformed_response');

    return value as Record<string, unknown>;
  }

  private static text(value: unknown): string {
    if (typeof value !== 'string' || !value) throw new ServerEnrollmentError(502, 'malformed_response');

    return value;
  }

  /** Ids go into the signed path verbatim, so only URL-safe ids are accepted. */
  private static segment(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError('id is invalid');

    return id;
  }
}
