// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Desktop-only control surface for Passwords sync v3. Electron main calls
// these with the approval service identity (the same caller that already
// relays Sulla Cloud requests). Responses carry handles, hashes and counts,
// never bodies, keys or plaintext.

import type express from 'express';

import { EnvelopeError } from './envelope.js';
import { CloudSyncError, type CloudVaultSyncRunner, type SyncOp } from './syncRunner.js';

type Handler = (request: express.Request) => Promise<unknown>;
type DesktopIdentityCheck = (request: express.Request) => void;

export class CloudSyncRoutes {
  private readonly ops: ReadonlySet<SyncOp> = new Set<SyncOp>(['enable', 'replace', 'commit', 'rewrap', 'pause', 'resume', 'delete']);
  private readonly uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private readonly deviceIdPattern = /^[A-Za-z0-9_.-]{8,128}$/;

  constructor(
    private readonly runner: CloudVaultSyncRunner,
    private readonly requireDesktopIdentity: DesktopIdentityCheck,
  ) {}

  register(app: express.Express): void {
    const runner = this.runner;
    this.route(app, 'status', () => runner.status());
    this.route(app, 'pull', request => runner.pull(this.deviceId(request)));
    this.route(app, 'prepare', request => {
      const op = request.body?.op as SyncOp;
      if (!this.ops.has(op)) throw new CloudSyncError('invalid_operation', 400, 'Unknown sync operation');
      return runner.prepare(op, this.deviceId(request));
    });
    this.route(app, 'send', request => {
      const handle = request.body?.handle;
      if (typeof handle !== 'string' || handle.length > 64) throw new CloudSyncError('invalid_handle', 400, 'handle is required');
      return runner.send(handle, { ts: Number(request.body?.ts), signature: request.body?.signature });
    });
    this.route(app, 'held/list', async() => ({ held: await runner.heldList() }));
    this.route(app, 'held/approve', request => runner.heldApprove(this.recordId(request)));
    this.route(app, 'held/reject', request => runner.heldReject(this.recordId(request)));
    this.route(app, 'forget', async() => { await runner.forget(); return { ok: true } });
  }

  private route(app: express.Express, path: string, handler: Handler): void {
    // Called as a plain function (no receiver), exactly as the pre-E9 module did.
    const requireDesktopIdentity = this.requireDesktopIdentity;
    app.post(`/v1/desktop/cloud-sync/${ path }`, async(request, response) => {
      try {
        requireDesktopIdentity(request);
        response.json(await handler(request));
      } catch (error) {
        if (error instanceof CloudSyncError) {
          response.status(error.status).json({ error: error.code, message: error.message });
        } else if (error instanceof EnvelopeError) {
          // Integrity failures are reported by code only; nothing about the record leaks.
          response.status(409).json({ error: 'integrity_failed', reason: error.code, message: error.message });
        } else {
          const status = (error as { status?: number })?.status;
          const code = (error as { code?: string })?.code;
          response.status(typeof status === 'number' ? status : 500).json({ error: code ?? 'cloud_sync_failed' });
        }
      }
    });
  }

  private deviceId(request: express.Request): string {
    const value = request.body?.deviceId;
    if (typeof value !== 'string' || !this.deviceIdPattern.test(value)) throw new CloudSyncError('invalid_device', 400, 'deviceId is required');
    return value;
  }

  private recordId(request: express.Request): string {
    const value = request.body?.recordId;
    if (typeof value !== 'string' || !this.uuid.test(value)) throw new CloudSyncError('invalid_record', 400, 'recordId is required');
    return value;
  }
}
