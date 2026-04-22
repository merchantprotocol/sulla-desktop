// sullaSecretsServer
//
// A tiny HTTP server hosted by the Electron main process. Runtime containers
// running inside the Lima VM reach this server via `host.lima.internal:30121`
// during a single function invocation to fetch secrets, using a short-lived
// capability token that the playbook minted for that exact invocation.
//
// Binding: 127.0.0.1 only. The Lima VM has `host.lima.internal` mapped to the
// host loopback, so this endpoint is reachable from the VM but not from any
// other host on the network. DO NOT bind to 0.0.0.0.
//
// Surface: plain HTTP on Node's stdlib only. This is deliberately NOT on the
// Electron IPC channel — runtime containers cannot reach IPC, and the
// capability-token flow does not need Electron-privileged callers.

import * as http from 'http';

import {
  getSecretsCapabilityService,
  SecretsResolveError,
} from '@pkg/agent/services/SecretsCapabilityService';

const DEFAULT_PORT = 30121;
const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024;

let server: http.Server | null = null;

/**
 * Start the secrets HTTP server. Idempotent: re-calling while running is a
 * no-op.
 */
export async function startSullaSecretsServer(port: number = DEFAULT_PORT): Promise<void> {
  if (server) return;

  const srv = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.warn('[SullaSecretsServer] Unhandled request error:', err?.message ?? err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal_error' });
      } else {
        try { res.end() } catch { /* socket dead */ }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, BIND_HOST);
  });

  server = srv;
  console.log(`[SullaSecretsServer] Listening on http://${ BIND_HOST }:${ port }`);
}

/**
 * Stop the secrets HTTP server. Idempotent.
 */
export async function stopSullaSecretsServer(): Promise<void> {
  const srv = server;
  server = null;
  if (!srv) return;

  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
  console.log('[SullaSecretsServer] Stopped');
}

// ─── Request handling ─────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && url === '/health') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'POST' && url === '/secrets/fetch') {
    await handleFetch(req, res);
    return;
  }

  if (method === 'POST' && url === '/secrets/invalidate') {
    await handleInvalidate(req, res);
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

async function handleFetch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    const code = err?.code === 'body_too_large' ? 413 : 400;
    writeJson(res, code, { error: err?.code ?? 'bad_request' });
    return;
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const key = typeof body.key === 'string' ? body.key : '';
  if (!token || !key) {
    // Do NOT include the key or token in the error body.
    writeJson(res, 400, { error: 'invalid_request' });
    return;
  }

  try {
    const value = await getSecretsCapabilityService().resolve(token, key);
    writeJson(res, 200, { value });
  } catch (err) {
    if (err instanceof SecretsResolveError) {
      const status = statusForOutcome(err.outcome);
      writeJson(res, status, { error: err.outcome });
      return;
    }
    // Unknown failure: do not leak specifics.
    console.warn('[SullaSecretsServer] fetch failed:', (err as any)?.message ?? 'unknown');
    writeJson(res, 500, { error: 'internal_error' });
  }
}

async function handleInvalidate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    const code = err?.code === 'body_too_large' ? 413 : 400;
    writeJson(res, code, { error: err?.code ?? 'bad_request' });
    return;
  }

  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) {
    writeJson(res, 400, { error: 'invalid_request' });
    return;
  }

  getSecretsCapabilityService().invalidate(token);
  writeJson(res, 200, { invalidated: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body).toString(),
    'Cache-Control':  'no-store',
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error('request body too large');
        (err as any).code = 'body_too_large';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf-8') || '{}';
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('invalid body');
          (err as any).code = 'invalid_request';
          reject(err);
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        const err = new Error('invalid json');
        (err as any).code = 'invalid_request';
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function statusForOutcome(outcome: string): number {
  switch (outcome) {
  case 'unknown-token':        return 401;
  case 'expired':              return 401;
  case 'key-not-allowed':      return 403;
  case 'key-already-consumed': return 409;
  case 'not-found':            return 404;
  default:                     return 400;
  }
}
