import crypto from 'node:crypto';
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
  const token = crypto.randomBytes(48).toString('base64url');

  beforeEach(async() => {
    fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-native-source-'));
    gateway = new SullaFilesSourceGateway(token);
    await gateway.start();
  });

  afterEach(async() => {
    await gateway.stop();
    await fs.promises.rm(fixture, { recursive: true, force: true });
  });

  test('round trips an explicitly registered file and fails closed on unknown handles', async() => {
    const source = path.join(fixture, 'synthetic.txt');
    await fs.promises.writeFile(source, 'original synthetic bytes\n');
    const handle = await gateway.registerExactFile(source);
    const first = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers: { 'x-sulla-files-token': token } });
    const revision = first.headers.etag;
    expect(first.status).toBe(200);
    expect(first.body.toString()).toBe('original synthetic bytes\n');
    const written = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, {
      method: 'PUT', headers: { 'if-match': revision!, 'x-sulla-files-token': token },
    }, 'edited through native gateway\n');
    expect(written.status).toBe(200);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('edited through native gateway\n');
    const unknown = await request(`${ gateway.loopbackUrl }/v1/sources/${ 'x'.repeat(43) }`, { headers: { 'x-sulla-files-token': token } });
    expect(unknown.status).toBe(404);
    const unauthorized = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`);
    expect(unauthorized.status).toBe(401);
    gateway.revoke(handle);
    const revoked = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, { headers: { 'x-sulla-files-token': token } });
    expect(revoked.status).toBe(404);
  });

  test('preserves staged bytes behind an opaque conflict handle after an external edit', async() => {
    const source = path.join(fixture, 'synthetic.txt');
    await fs.promises.writeFile(source, 'original synthetic bytes\n');
    const handle = await gateway.registerExactFile(source);
    const baseline = await gateway.read(handle);
    await fs.promises.writeFile(source, 'external native edit\n');
    const response = await request(`${ gateway.loopbackUrl }/v1/sources/${ handle }`, {
      method:  'PUT',
      headers: { 'if-match': `"${ baseline.revision }"`, 'x-sulla-files-token': token },
    }, 'stale Files edit\n');
    const conflict = JSON.parse(response.body.toString()) as { error: string; conflictHandle: string };
    expect(response.status).toBe(409);
    expect(conflict.error).toBe('source_changed');
    expect(conflict.conflictHandle).not.toContain('/');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('external native edit\n');
    expect((await gateway.read(conflict.conflictHandle)).bytes.toString()).toBe('stale Files edit\n');
  });
});
