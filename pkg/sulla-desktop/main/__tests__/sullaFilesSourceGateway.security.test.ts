// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { SullaFilesSourceGateway } from '../sullaFilesSourceGateway';

function request(url:string, options:http.RequestOptions = {}, body?:string):Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, options, incoming => {
      const chunks:Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

describe('SullaFilesSourceGateway', () => {
  let fixture:string;
  let gateway:SullaFilesSourceGateway;
  beforeEach(async() => {
    fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-native-source-'));
    gateway = new SullaFilesSourceGateway();
    await gateway.start();
    gateway.unlock();
  });

  afterEach(async() => {
    await gateway.stop();
    await fs.promises.rm(fixture, { recursive: true, force: true });
  });

  test('round trips an explicitly registered file and fails closed on unknown handles', async() => {
    const source = path.join(fixture, 'synthetic.txt');
    await fs.promises.writeFile(source, 'original synthetic bytes\n');
    const handle = await gateway.registerExactFile(source);
    const capability = gateway.issueCapability(handle, 'sulla-files', ['read', 'write']);
    const headers = { 'x-sulla-source-capability': capability, 'x-sulla-source-service': 'sulla-files' };
    const first = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers });
    const revision = first.headers.etag;
    expect(first.status).toBe(200);
    expect(first.body.toString()).toBe('original synthetic bytes\n');
    const written = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, {
      method: 'PUT', headers: { ...headers, 'if-match': revision! },
    }, 'edited through native gateway\n');
    expect(written.status).toBe(200);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('edited through native gateway\n');
    const unknown = await request(`${ gateway.loopbackUrl }/v1/sources/${ 'x'.repeat(43) }`, { headers });
    expect(unknown.status).toBe(403);
    const unauthorized = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`);
    expect(unauthorized.status).toBe(401);
    gateway.revoke(handle);
    const revoked = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers });
    expect(revoked.status).toBe(403);
  });

  test('preserves staged bytes behind an opaque conflict handle after an external edit', async() => {
    const source = path.join(fixture, 'synthetic.txt');
    await fs.promises.writeFile(source, 'original synthetic bytes\n');
    const handle = await gateway.registerExactFile(source);
    const capability = gateway.issueCapability(handle, 'sulla-files', ['read', 'write']);
    const baseline = await gateway.read(handle);
    await fs.promises.writeFile(source, 'external native edit\n');
    const response = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, {
      method:  'PUT',
      headers: {
        'if-match':                  `"${ baseline.revision }"`,
        'x-sulla-source-capability': capability,
        'x-sulla-source-service':    'sulla-files',
      },
    }, 'stale Files edit\n');
    const conflict = JSON.parse(response.body.toString()) as { error: string; conflictHandle: string };
    expect(response.status).toBe(409);
    expect(conflict.error).toBe('source_changed');
    expect(conflict.conflictHandle).not.toContain('/');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('external native edit\n');
    expect((await gateway.read(conflict.conflictHandle)).bytes.toString()).toBe('stale Files edit\n');
  });

  test('revokes every source capability on lock and rejects pathname identity replacement', async() => {
    const source = path.join(fixture, 'synthetic.txt');
    await fs.promises.writeFile(source, 'original synthetic bytes\n');
    const handle = await gateway.registerExactFile(source);
    const capability = gateway.issueCapability(handle, 'sulla-files', ['read']);
    const headers = { 'x-sulla-source-capability': capability, 'x-sulla-source-service': 'sulla-files' };
    await fs.promises.rename(source, `${ source }.old`);
    await fs.promises.writeFile(source, 'replacement identity\n');
    const replaced = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers });
    expect(replaced.status).toBe(409);
    await gateway.lock();
    const locked = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers });
    expect(locked.status).toBe(403);
  });
});
