import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { pinnedLookup } from './pinnedLookup.js';

test('pinned lookup supports Node address-family autoselection', async() => {
  const server = net.createServer(socket => socket.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const body = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({
        host: 'synthetic.invalid', port: address.port, lookup: pinnedLookup('127.0.0.1', 4),
      });
      let output = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { output += chunk });
      socket.on('end', () => resolve(output));
      socket.on('error', reject);
    });
    assert.equal(body, 'ok');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
