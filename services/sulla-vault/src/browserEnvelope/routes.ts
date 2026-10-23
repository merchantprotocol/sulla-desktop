// Desktop-only control surface for Passwords sync v3. Electron main calls
// these with the approval service identity (the same caller that already
// relays Sulla Cloud requests). Responses carry handles, hashes and counts,
// never bodies, keys or plaintext.

import type express from 'express';

import { EnvelopeError } from './envelope.js';
import { CloudSyncError, type CloudVaultSyncRunner, type SyncOp } from './syncRunner.js';

const OPS = new Set<SyncOp>(['enable', 'replace', 'commit', 'pause', 'resume', 'delete']);
const DEVICE_ID = /^[A-Za-z0-9_.-]{8,128}$/;

type Handler = (request: express.Request) => Promise<unknown>;

export function registerCloudSyncRoutes(
  app: express.Express,
  runner: CloudVaultSyncRunner,
  requireDesktopIdentity: (request: express.Request) => void,
): void {
  const route = (path: string, handler: Handler) => {
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
  };
  const deviceId = (request: express.Request) => {
    const value = request.body?.deviceId;
    if (typeof value !== 'string' || !DEVICE_ID.test(value)) throw new CloudSyncError('invalid_device', 400, 'deviceId is required');
    return value;
  };

  route('status', () => runner.status());
  route('pull', request => runner.pull(deviceId(request)));
  route('prepare', request => {
    const op = request.body?.op as SyncOp;
    if (!OPS.has(op)) throw new CloudSyncError('invalid_operation', 400, 'Unknown sync operation');
    return runner.prepare(op, deviceId(request));
  });
  route('send', request => {
    const handle = request.body?.handle;
    if (typeof handle !== 'string' || handle.length > 64) throw new CloudSyncError('invalid_handle', 400, 'handle is required');
    return runner.send(handle, { ts: Number(request.body?.ts), signature: request.body?.signature });
  });
  route('forget', async() => { await runner.forget(); return { ok: true } });
}
