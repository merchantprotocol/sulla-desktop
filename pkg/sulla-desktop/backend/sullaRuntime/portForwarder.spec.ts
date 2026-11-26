// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => ({ default: { sullaRuntime: console } }));
vi.mock('@pkg/utils/portOwner', () => ({ describePortOwner: vi.fn() }));

import { SullaRuntimePortForwarder } from './portForwarder';

class TestablePortForwarder extends SullaRuntimePortForwarder {
  accept(client:net.Socket):void {
    this.relay(client, 30124);
  }
}

describe('SullaRuntimePortForwarder relay', () => {
  it('destroys the client socket when the guest half-closes without closing its write side', async() => {
    // risk: availability — Chromium must observe a dead upstream instead of pinning a half-open socket.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-files-forwarder-'));
    const guestPath = path.join(directory, 'guest.sock');
    const guestServer = net.createServer({ allowHalfOpen: true }, socket => {
      let received = '';
      socket.on('data', chunk => {
        received += chunk.toString();
        if (received.includes('request')) socket.end();
      });
    });
    const clientServer = net.createServer(client => forwarder.accept(client));
    const forwarder = new TestablePortForwarder('/unused/docker.sock', guestPath);
    let client:net.Socket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        guestServer.once('error', reject);
        guestServer.listen(guestPath, resolve);
      });
      await new Promise<void>((resolve, reject) => {
        clientServer.once('error', reject);
        clientServer.listen(0, '127.0.0.1', resolve);
      });
      const address = clientServer.address();
      if (!address || typeof address === 'string') throw new Error('Forwarder test listener did not bind TCP');

      client = net.connect(address.port, '127.0.0.1');
      await once(client, 'connect');
      const closed = once(client, 'close');
      client.write('request');
      let closeTimeout:NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            closeTimeout = setTimeout(() => reject(new Error('client socket stayed open after guest close')), 1_000);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }

      expect(client.destroyed).toBe(true);
    } finally {
      client?.destroy();
      await Promise.all([guestServer, clientServer].map(server => new Promise<void>(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      })));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
