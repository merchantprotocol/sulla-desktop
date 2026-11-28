// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { lookup } from 'node:dns/promises';

import type { PinnedAddress } from '../../src/pinnedLookup.js';
import type { LocalAuthorityHost } from '../../src/localAuthority/LocalAuthorityHost.js';
import { LocalVaultError } from '../../src/localAuthority/LocalVaultError.js';
import { UpstreamHttpClient } from '../../src/localAuthority/UpstreamHttpClient.js';

/** Exact-origin loopback exception, constructed only by the test vault composition root. */
export class TestOnlyUpstreamHttpClient extends UpstreamHttpClient {
  private readonly allowedOrigin: string;
  private readonly allowedHostname: string;

  constructor(
    host: LocalAuthorityHost,
    allowedOrigin: string,
    testCa: Buffer,
  ) {
    super(host, undefined, testCa);
    const parsed = new URL(allowedOrigin);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.openai.com' || !parsed.port) {
      throw new Error('Test upstream must be the harness-generated HTTPS endpoint');
    }
    this.allowedOrigin = parsed.origin;
    this.allowedHostname = parsed.hostname;
  }

  override async validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses: PinnedAddress[] }> {
    let target: URL;
    try { target = new URL(raw); } catch {
      throw new LocalVaultError('invalid_destination', 400, 'Destination URL is invalid');
    }
    if (target.origin !== this.allowedOrigin) {
      throw new LocalVaultError('destination_denied', 403, 'Test vault may reach only its generated synthetic upstream');
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.hostname !== this.allowedHostname) {
      throw new LocalVaultError('destination_denied', 403, 'Test vault may reach only its generated synthetic upstream');
    }
    // Resolve only the OS localhost entry (never api.openai.com or another public hostname). This
    // exercises Node's DNS/libuv path under load while the returned pin remains loopback-only.
    const resolved = await lookup('localhost', { all: true, family: 4, verbatim: true });
    const loopback = resolved.find(address => address.address === '127.0.0.1' && address.family === 4);
    if (!loopback) throw new LocalVaultError('destination_denied', 403, 'Test resolver did not return IPv4 loopback');
    const pinnedAddresses: PinnedAddress[] = [{ address: loopback.address, family: 4 }];
    return Object.assign(target, {
      pinnedAddress: '127.0.0.1',
      pinnedFamily: 4 as const,
      pinnedAddresses,
    });
  }

  protected override async resolvePinnedAddresses(hostname: string): Promise<PinnedAddress[]> {
    if (hostname !== this.allowedHostname) {
      throw new LocalVaultError('destination_denied', 403, 'Test vault may resolve only its generated synthetic upstream');
    }
    return [{ address: '127.0.0.1', family: 4 }];
  }
}
