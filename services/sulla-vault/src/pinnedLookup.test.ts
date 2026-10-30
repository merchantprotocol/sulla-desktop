// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { pinnedAddressesLookup, pinnedLookup } from './pinnedLookup.js';

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

test('multi-address pinned lookup preserves validated failover addresses', async() => {
  const lookup = pinnedAddressesLookup([
    { address: '192.0.2.10', family: 4 },
    { address: '2001:db8::10', family: 6 },
  ]);
  const addresses = await new Promise((resolve, reject) => {
    lookup('synthetic.invalid', { all: true }, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.deepEqual(addresses, [
    { address: '192.0.2.10', family: 4 },
    { address: '2001:db8::10', family: 6 },
  ]);
});
