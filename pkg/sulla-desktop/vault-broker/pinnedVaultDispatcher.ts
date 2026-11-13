// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import tls from 'node:tls';

import { Agent, fetch as undiciFetch } from 'undici';

import type { VaultBrokerFetch } from './index';
import type { VaultCertificateMetadata } from '@pkg/main/vaultTlsVerifier';

export interface PinnedVaultDispatcherOptions {
  /** Current SHA-256 pin of the vault leaf certificate. Re-read for every new socket. */
  fingerprint(): Promise<string>;
  /** Pin check. Must return true only for the exact provisioned vault certificate. */
  verify(hostname: string, certificate: VaultCertificateMetadata, expectedFingerprint: string): boolean;
  /** Most sockets kept open to the vault at once. */
  connections?:      number;
  connectTimeoutMs?: number;
  /** Longest wait for response headers (provider calls stream headers fast). */
  headersTimeoutMs?: number;
  /** Longest silence between body chunks before the socket counts as stuck. */
  bodyTimeoutMs?:    number;
  /** Seam for tests: opens the TLS socket. */
  connectTls?: (options: tls.ConnectionOptions) => tls.TLSSocket;
}

interface ConnectorOptions {
  hostname:    string;
  port:        string;
  servername?: string;
}

type ConnectorCallback = (...args: [null, tls.TLSSocket] | [Error, null]) => void;

/**
 * Node HTTPS transport to the local vault, pinned to its certificate fingerprint.
 *
 * Desktop used Electron `session.fetch` for this. Chromium allows only 6
 * HTTP/1.1 sockets per host, and every provider CLI stream holds one socket for
 * its whole response, so with more than 6 agents streaming every other vault
 * call (more provider calls, OAuth refresh, tool credentials, approvals) queued
 * for 10+ seconds. This dispatcher has its own bounded keep-alive pool and
 * timeouts, and it checks the pin before undici writes a single request byte.
 */
export class PinnedVaultDispatcher {
  private readonly agent: Agent;
  private readonly connectTls: (options: tls.ConnectionOptions) => tls.TLSSocket;

  constructor(private readonly options: PinnedVaultDispatcherOptions) {
    this.connectTls = options.connectTls ?? (connectOptions => tls.connect(connectOptions));
    this.agent = new Agent({
      connections:    options.connections ?? 256,
      keepAliveTimeout: 30_000,
      headersTimeout: options.headersTimeoutMs ?? 10 * 60_000,
      bodyTimeout:    options.bodyTimeoutMs ?? 10 * 60_000,
      connect:        (connectOptions, callback) => {
        this.connect(connectOptions as unknown as ConnectorOptions, callback as unknown as ConnectorCallback);
      },
    });
  }

  readonly fetch: VaultBrokerFetch = (input, init) => {
    return undiciFetch(input as string, {
      ...init,
      dispatcher: this.agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };

  async close(): Promise<void> {
    await this.agent.close();
  }

  private connect(options: ConnectorOptions, callback: ConnectorCallback): void {
    let settled = false;
    const finish = (error: Error | null, socket?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket?.destroy();
        callback(error, null);
      } else {
        callback(null, socket!);
      }
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Vault TLS connect timed out'), { code: 'ETIMEDOUT' }), socket),
      this.options.connectTimeoutMs ?? 10_000);
    // The certificate is self-signed and pinned, so chain validation is replaced
    // by the exact fingerprint check below. No session resumption: every socket
    // presents the certificate again and is checked again.
    const socket = this.connectTls({
      host:               options.hostname,
      port:               Number(options.port),
      servername:         options.servername || undefined,
      rejectUnauthorized: false,
      ALPNProtocols:      ['http/1.1'],
    });
    socket.once('error', error => finish(error, socket));
    socket.once('secureConnect', () => {
      void this.options.fingerprint().then(expected => {
        const certificate = socket.getPeerX509Certificate();
        if (!certificate || !this.options.verify(options.hostname, certificate as unknown as VaultCertificateMetadata, expected)) {
          finish(new Error('Vault TLS certificate does not match the provisioned pin'), socket);
          return;
        }
        socket.setNoDelay(true);
        finish(null, socket);
      }, error => finish(error instanceof Error ? error : new Error(String(error)), socket));
    });
  }
}
