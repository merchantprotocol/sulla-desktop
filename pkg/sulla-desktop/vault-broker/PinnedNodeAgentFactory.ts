// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import net from 'node:net';
import tls from 'node:tls';

import { Agent } from 'undici';

export type PinnedNodeAgentVerifier = (hostname: string, certificatePem: string) => Promise<boolean>;
export type PinnedNodeAgentFactoryFunction = (options: Agent.Options) => Agent;

/** Builds bounded undici Agents that accept only peers approved by the caller's certificate pin. */
export class PinnedNodeAgentFactory {
  constructor(
    private readonly createAgent: PinnedNodeAgentFactoryFunction = options => new Agent(options),
    private readonly tlsConnect: typeof tls.connect = tls.connect,
  ) {}

  create(connections: number, verifyPeer: PinnedNodeAgentVerifier, pinFailureMessage: string): Agent {
    return this.createAgent({
      connections,
      connect: (options, callback) => {
        const hostname = typeof options.hostname === 'string' ? options.hostname : '';
        // Match undici's connector defaults while keeping certificate acceptance under the pin verifier.
        const socket = this.tlsConnect({
          host: hostname,
          port: Number(options.port) || 443,
          servername: options.servername ?? (net.isIP(hostname) ? undefined : hostname),
          rejectUnauthorized: false,
        });
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          callback(error, null);
        };
        const succeed = (connected: tls.TLSSocket) => {
          if (settled) return;
          settled = true;
          callback(null, connected);
        };
        socket.once('error', error => fail(error));
        socket.once('secureConnect', () => {
          void (async() => {
            const certificate = socket.getPeerCertificate(true);
            const raw = certificate.raw;
            const pem = raw ? `-----BEGIN CERTIFICATE-----\n${ raw.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----` : '';
            if (!pem || !await verifyPeer(hostname, pem)) {
              socket.destroy();
              fail(new Error(pinFailureMessage));
              return;
            }
            succeed(socket);
          })().catch((error) => {
            socket.destroy();
            fail(error as Error);
          });
        });
        return socket;
      },
    });
  }
}
