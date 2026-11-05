// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isIP } from 'net';
import { promises as dns } from 'dns';

export interface BrowserDnsResolver {
  lookup(hostname: string, options: { all: true; verbatim: true }): Promise<Array<{ address: string }>>;
}

export class BrowserUrlPolicy {
  constructor(private readonly resolver: BrowserDnsResolver = dns) {}

  async validate(raw: string, allowedOrigins: readonly string[] = []): Promise<URL> {
    let url: URL;
    try { url = new URL(raw) } catch { throw new Error('invalid-url') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');

    const allowed = allowedOrigins.map(origin => this.canonicalOrigin(origin));
    if (allowed.length > 0 && !allowed.includes(url.origin)) throw new Error('origin-not-allowed');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'host.sulla.internal' || hostname.endsWith('.sulla.internal')) {
      throw new Error('unsafe-network-target');
    }
    const addresses = isIP(hostname) ? [hostname] : (await this.resolver.lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
    if (addresses.length === 0 || addresses.some(address => this.isUnsafeAddress(address))) throw new Error('unsafe-network-target');
    return url;
  }

  private canonicalOrigin(raw: string): string {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new Error('invalid-url') }
  }

  private isUnsafeAddress(raw: string): boolean {
    const mapped = raw.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const address = mapped ?? raw.toLowerCase();
    if (isIP(address) === 4) {
      const n = address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
      return BrowserUrlPolicy.V4_BLOCKS.some(([base, bits]) => bits === 0 || (n >>> (32 - bits)) === (base >>> (32 - bits)));
    }
    if (isIP(address) !== 6) return true;
    const words = this.ipv6Words(address);
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
      return this.isUnsafeAddress(`${ words[6] >> 8 }.${ words[6] & 255 }.${ words[7] >> 8 }.${ words[7] & 255 }`);
    }
    const normalized = address.replace(/^0+/, '');
    return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') ||
      /^fe[89ab]/.test(address) || address.startsWith('ff') || normalized.startsWith('2001:db8:') ||
      address.startsWith('2001:10:') || address.startsWith('100:');
  }

  private ipv6Words(address: string): number[] {
    const halves = address.split('::');
    const parse = (part: string): number[] => part ? part.split(':').map(word => parseInt(word || '0', 16)) : [];
    const left = parse(halves[0]); const right = parse(halves[1] ?? '');
    return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
  }

  private static readonly V4_BLOCKS: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
    [0xe0000000, 4], [0xf0000000, 4], [0xffffffff, 32],
  ];
}
