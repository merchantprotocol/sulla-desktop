// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeMode = 'new-user' | 'existing-user' | 'error' | 'timeout';
export async function startFakeServer(mode: FakeMode = 'new-user') {
  const requests: Array<{ path: string; body: any }> = [];
  const server = http.createServer(async(req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    let body: any = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    requests.push({ path: req.url || '/', body });
    if (mode === 'timeout') return;
    if (mode === 'error') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'temporarily unavailable' })); return; }
    const existing = mode === 'existing-user';
    if (req.url === '/auth/email/login' && existing) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(session())); return;
    }
    if (req.url === '/auth/email/register' && !existing) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(session())); return;
    }
    if (req.url?.includes('/auth/email/')) {
      res.writeHead(existing ? 409 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: existing ? 'account_exists' : 'not_found' })); return;
    }
    if (req.url === '/oauth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, access_token: 'test-secret-token' })); return; }
    if (req.url === '/vault/write') { res.writeHead(204); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
function session() { return { contractor: { id: 'test-user', email: 'person@example.test', phone: '', business_name: null, name: 'Test' }, accessToken: 'cloud-access-secret', refreshToken: 'cloud-refresh-secret' }; }
