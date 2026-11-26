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

const FILES_PORT = 30124;
const RELAY_PORT = 30126;

class TestablePortForwarder extends SullaRuntimePortForwarder {
  constructor(guestSocket:string, filesIdleTimeoutMs:number) {
    super('/unused/docker.sock', guestSocket, { filesPort: FILES_PORT, filesIdleTimeoutMs });
  }

  accept(client:net.Socket, port:number):void {
    this.relay(client, port);
  }
}

describe('SullaRuntimePortForwarder relay', () => {
  it.each([FILES_PORT, RELAY_PORT])('preserves a half-closed relay on port %i', async(port) => {
    // risk: availability — Files uses TLS and other published ports may use legitimate half-close protocols.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-port-forwarder-half-close-'));
    const guestPath = path.join(directory, 'guest.sock');
    let resolveLatePayload!: () => void;
    const latePayloadReceived = new Promise<void>(resolve => {
      resolveLatePayload = resolve;
    });
    const guestServer = net.createServer({ allowHalfOpen: true }, socket => {
      let received = '';
      let sentResponse = false;
      socket.on('data', chunk => {
        received += chunk.toString();
        if (!sentResponse && received.includes('request')) {
          sentResponse = true;
          socket.end('response');
        }
        if (sentResponse && received.includes('after-half-close')) resolveLatePayload();
      });
    });
    const clientServer = net.createServer({ allowHalfOpen: true }, client => forwarder.accept(client, port));
    const forwarder = new TestablePortForwarder(guestPath, 5_000);
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

      client = net.createConnection({ port: address.port, host: '127.0.0.1', allowHalfOpen: true });
      let response = '';
      client.setEncoding('utf8');
      client.on('data', chunk => {
        response += chunk;
      });
      await once(client, 'connect');
      client.write('request');
      await once(client, 'end');

      expect(response).toBe('response');
      expect(client.destroyed).toBe(false);
      client.write('after-half-close');
      let timeout:NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          latePayloadReceived,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('relay discarded data after a half-close')), 1_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      client?.destroy();
      await Promise.all([guestServer, clientServer].map(server => new Promise<void>(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      })));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies the idle timeout only to the configured Files port', async() => {
    // risk: availability — stale Files keep-alives must expire without cutting idle WebSockets or DB sessions.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-port-forwarder-idle-'));
    const guestPath = path.join(directory, 'guest.sock');
    const guestSockets:net.Socket[] = [];
    let filesRelaySocket:net.Socket | undefined;
    let relaySocket:net.Socket | undefined;
    let resolveFilesRelayClosed!: () => void;
    const filesRelayClosed = new Promise<void>(resolve => {
      resolveFilesRelayClosed = resolve;
    });
    const guestServer = net.createServer({ allowHalfOpen: true }, socket => guestSockets.push(socket));
    const filesServer = net.createServer({ allowHalfOpen: true }, client => {
      filesRelaySocket = client;
      client.once('close', resolveFilesRelayClosed);
      forwarder.accept(client, FILES_PORT);
    });
    const relayServer = net.createServer({ allowHalfOpen: true }, client => {
      relaySocket = client;
      client.on('close', () => {
        relayClosed = true;
      });
      forwarder.accept(client, RELAY_PORT);
    });
    const forwarder = new TestablePortForwarder(guestPath, 250);
    let filesClient:net.Socket | undefined;
    let relayClient:net.Socket | undefined;
    let relayClosed = false;

    try {
      await new Promise<void>((resolve, reject) => {
        guestServer.once('error', reject);
        guestServer.listen(guestPath, resolve);
      });
      await Promise.all([filesServer, relayServer].map(server => new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      })));
      const filesAddress = filesServer.address();
      const relayAddress = relayServer.address();
      if (!filesAddress || typeof filesAddress === 'string' || !relayAddress || typeof relayAddress === 'string') {
        throw new Error('Forwarder test listeners did not bind TCP');
      }

      filesClient = net.createConnection({ port: filesAddress.port, host: '127.0.0.1', allowHalfOpen: true });
      relayClient = net.createConnection({ port: relayAddress.port, host: '127.0.0.1', allowHalfOpen: true });
      await Promise.all([once(filesClient, 'connect'), once(relayClient, 'connect')]);
      let timeout:NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          filesRelayClosed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Files relay did not expire while idle')), 1_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      await new Promise(resolve => setTimeout(resolve, 275));

      expect(filesRelaySocket?.destroyed).toBe(true);
      expect(relaySocket?.destroyed).toBe(false);
      expect(relayClosed).toBe(false);
    } finally {
      filesClient?.destroy();
      relayClient?.destroy();
      guestSockets.forEach(socket => socket.destroy());
      await Promise.all([guestServer, filesServer, relayServer].map(server => new Promise<void>(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      })));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
