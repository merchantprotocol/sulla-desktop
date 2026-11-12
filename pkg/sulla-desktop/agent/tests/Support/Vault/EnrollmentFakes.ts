// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One HTTP call the code under test made to Sulla Cloud. */
export interface RecordedCloudCall {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface FakeCloudReply { readonly status: number; readonly body?: unknown }

/**
 * A scripted Sulla Cloud for the vault enrollment routes (synthetic data only). It answers the
 * paths sulla-workers serves (`src/routes/cloud-vault-sync.ts`) with the same `{ error }` bodies.
 */
export class FakeEnrollmentCloud {
  readonly calls: RecordedCloudCall[] = [];
  status: FakeCloudReply = { status: 200, body: { enabled: true, vaultId: '', epoch: 3 } };
  state: FakeCloudReply = { status: 200, body: { state: 'waiting_for_approver' } };
  readonly openReplies: FakeCloudReply[] = [];
  readonly consumeReplies: FakeCloudReply[] = [];
  confirmReply: FakeCloudReply = { status: 200, body: { ok: true, trusted: true } };
  listReply: FakeCloudReply = { status: 200, body: { requests: [] } };
  bundleReply: FakeCloudReply = { status: 200, body: { bundle: { epoch: 3, mac: 'bundle-mac' } } };
  recordsReply: FakeCloudReply = { status: 200, body: { records: [{ id: 'r1' }], head: { mac: 'head-mac', vaultId: '' } } };
  respondReply: FakeCloudReply = { status: 200, body: { ok: true } };
  private nextRequest = 1;

  constructor(readonly vaultId: string, readonly epoch = 3) {
    this.status = { status: 200, body: { enabled: true, vaultId, epoch } };
    this.state = { status: 200, body: { state: 'waiting_for_approver', vaultId, epoch } };
    this.recordsReply = { status: 200, body: { records: [{ id: 'r1' }], head: { mac: 'head-mac', vaultId } } };
  }

  /** Same shape as main/cloud/cloudFetch `cloudRequest(method, url, options)`. */
  async request(method: string, url: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    const parsed = new URL(url, 'https://cloud.test');
    const body = typeof options.body === 'string' ? options.body : options.body === undefined ? undefined : String(options.body);
    this.calls.push({ method, path: parsed.pathname, query: parsed.searchParams, headers: { ...(options.headers ?? {}) }, body });
    return this.reply(this.route(method, parsed.pathname));
  }

  callsTo(suffix: string, method?: string): RecordedCloudCall[] {
    return this.calls.filter(call => call.path.endsWith(suffix) && (method === undefined || call.method === method));
  }

  private route(method: string, pathname: string): FakeCloudReply {
    const base = `/cloud-vault-sync/vaults/${ encodeURIComponent(this.vaultId) }`;
    if (pathname === '/cloud-vault-sync/status') return this.status;
    if (pathname === '/cloud-vault-sync/enrollment/state') return this.state;
    if (pathname === `${ base }/enrollment/requests` && method === 'POST') {
      return this.openReplies.shift() ?? { status: 201, body: { id: `req-000${ this.nextRequest++ }`, vaultId: this.vaultId, epoch: this.epoch, expiresIn: 300 } };
    }
    if (pathname === `${ base }/enrollment/requests` && method === 'GET') return this.listReply;
    if (pathname.endsWith('/consume')) return this.consumeReplies.shift() ?? { status: 409, body: { error: 'request_not_found_or_consumed' } };
    if (pathname.endsWith('/confirm')) return this.confirmReply;
    if (pathname.endsWith('/respond')) return this.respondReply;
    if (pathname === `${ base }/bundle`) return this.bundleReply;
    if (pathname === `${ base }/records`) return this.recordsReply;
    return { status: 404, body: { error: 'not_found' } };
  }

  private reply(reply: FakeCloudReply): Response {
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }
}

/** The vault container's broker client, scripted. Records every call in order. */
export class FakeVaultBroker {
  /** Pass a shared array to interleave broker calls with Cloud calls in one timeline. */
  constructor(readonly events: string[] = []) {}
  readonly adoptCalls: Record<string, unknown>[] = [];
  readonly wrapCalls: Record<string, unknown>[] = [];
  readonly commitCalls: string[] = [];
  adoptResult: Record<string, unknown> = { bundleMac: 'bundle-mac', headMac: 'head-mac' };
  wrapResult: Record<string, unknown> = { wrappedUserKey: { format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', epk: 'epk', nonce: 'n', ct: 'c' } };
  legacyRequests: unknown[] = [];

  async adoptVaultEnrollment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.events.push('adopt'); this.adoptCalls.push(args);
    return this.adoptResult;
  }

  async commitVaultEnrollment(requestId: string): Promise<void> {
    this.events.push('commit'); this.commitCalls.push(requestId);
  }

  async wrapVaultEnrollment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.events.push('wrap'); this.wrapCalls.push(args);
    return this.wrapResult;
  }

  async wrapUserKeyForApprovedDevice(): Promise<{ wrappedUserKey: string }> {
    this.events.push('legacy-wrap');
    return { wrappedUserKey: 'legacy' };
  }

  async sullaCloudRequest(args: { method: string; path: string }): Promise<{ status: number; body: unknown }> {
    this.events.push(`legacy:${ args.method } ${ args.path }`);
    return { status: 200, body: { requests: this.legacyRequests } };
  }
}

/**
 * A throwaway ~/.sulla with a fixed Ed25519 device key (seed 0x01..0x20) in today's
 * device-key.json format (PKCS#8 PEM, v1), so signatures are known-answer bytes.
 */
export class FixedDeviceKeyDir {
  static readonly SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  static readonly PUBLIC_KEY_B64 = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=';
  readonly dir: string;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-device-'));
    const key = FixedDeviceKeyDir.privateKey();
    fs.writeFileSync(path.join(this.dir, 'device-key.json'), JSON.stringify({
      v: 1, publicKey: FixedDeviceKeyDir.PUBLIC_KEY_B64, privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString(), createdAt: '2026-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
  }

  static privateKey(): crypto.KeyObject {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), FixedDeviceKeyDir.SEED]);
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }

  static verify(message: string, signatureB64: string): boolean {
    return crypto.verify(null, Buffer.from(message), crypto.createPublicKey(FixedDeviceKeyDir.privateKey()), Buffer.from(signatureB64, 'base64'));
  }

  remove(): void { fs.rmSync(this.dir, { recursive: true, force: true }) }
}

/** A promise the test resolves by hand (to hold a dialog open). */
export class Deferred<T> {
  resolve!: (value: T) => void;
  readonly promise: Promise<T>;
  constructor() { this.promise = new Promise<T>(resolve => { this.resolve = resolve }) }
}
