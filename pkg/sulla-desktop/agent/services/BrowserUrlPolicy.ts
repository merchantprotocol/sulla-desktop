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
    if (isIP(raw) === 4) return this.matchesCidr(this.ipv4Value(raw), BrowserUrlPolicy.V4_BLOCKS, 32);
    if (isIP(raw) !== 6) return true;
    return this.matchesCidr(this.ipv6Value(raw), BrowserUrlPolicy.V6_BLOCKS, 128);
  }

  private ipv4Value(address: string): bigint {
    return address.split('.').reduce((value, octet) => (value << BigInt(8)) | BigInt(octet), BigInt(0));
  }

  private ipv6Value(address: string): bigint {
    const halves = address.split('::');
    const parse = (part: string): number[] => part ? part.split(':').flatMap(word => word.includes('.')
      ? [Number(this.ipv4Value(word) >> BigInt(16)), Number(this.ipv4Value(word) & BigInt('0xffff'))]
      : [parseInt(word || '0', 16)]) : [];
    const left = parse(halves[0]); const right = parse(halves[1] ?? '');
    return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right]
      .reduce((value, word) => (value << BigInt(16)) | BigInt(word), BigInt(0));
  }

  private matchesCidr(value: bigint, ranges: ReadonlyArray<readonly [bigint, number]>, width: number): boolean {
    return ranges.some(([base, bits]) => (value >> BigInt(width - bits)) === (base >> BigInt(width - bits)));
  }

  private static readonly V4_BLOCKS: ReadonlyArray<readonly [bigint, number]> = [
    [BigInt('0x00000000'), 8], [BigInt('0x0a000000'), 8], [BigInt('0x64400000'), 10], [BigInt('0x7f000000'), 8],
    [BigInt('0xa9fe0000'), 16], [BigInt('0xac100000'), 12], [BigInt('0xc0000000'), 24], [BigInt('0xc0000200'), 24],
    [BigInt('0xc0586300'), 24], [BigInt('0xc0a80000'), 16], [BigInt('0xc6120000'), 15], [BigInt('0xc6336400'), 24],
    [BigInt('0xcb007100'), 24], [BigInt('0xe0000000'), 4], [BigInt('0xf0000000'), 4], [BigInt('0xffffffff'), 32],
  ];
  private static readonly V6_BLOCKS: ReadonlyArray<readonly [bigint, number]> = [
    [BigInt(0), 128], [BigInt(1), 128], [BigInt(0), 96], [BigInt('0xffff00000000'), 96],
    [BigInt('0x64ff9b000000000000000000000000'), 96], [BigInt('0x64ff9b000100000000000000000000'), 48],
    [BigInt('0x1000000000000000000000000000000'), 64], [BigInt('0x20010000000000000000000000000000'), 23],
    [BigInt('0x20010db8000000000000000000000000'), 32], [BigInt('0x20020000000000000000000000000000'), 16],
    [BigInt('0xfc000000000000000000000000000000'), 7], [BigInt('0xfe800000000000000000000000000000'), 10],
    [BigInt('0xfec00000000000000000000000000000'), 10], [BigInt('0xff000000000000000000000000000000'), 8],
  ];
}
