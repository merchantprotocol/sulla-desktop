// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import net from 'node:net';

/**
 * SSRF guard for broker destinations: only global-unicast public addresses are allowed.
 * Moved verbatim from localAuthority.ts (E9). Static methods never use `this`.
 */
export class BrokerAddressPolicy {
  static privateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
      const [a, b] = address.split('.').map(Number);
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (!net.isIPv6(address)) return true;
    const value = address.toLowerCase().split('%')[0];
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return BrokerAddressPolicy.privateAddress(mapped[1]);
    const expanded = BrokerAddressPolicy.expandIpv6(value);
    if (!expanded) return true;
    const first = expanded[0];
    const first32 = (BigInt(expanded[0]) << 16n) | BigInt(expanded[1]);
    // Accept only global-unicast 2000::/3 and reject documentation space.
    return (first & 0xe000) !== 0x2000 || first32 === 0x20010db8n;
  }

  static expandIpv6(value: string): number[] | null {
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string): number[] | null => {
      if (!part) return [];
      const output: number[] = [];
      for (const token of part.split(':')) {
        if (token.includes('.')) {
          if (!net.isIPv4(token)) return null;
          const bytes = token.split('.').map(Number);
          output.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
        } else {
          if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
          output.push(Number.parseInt(token, 16));
        }
      }
      return output;
    };
    const left = parse(halves[0]);
    const right = parse(halves[1] ?? '');
    if (!left || !right) return null;
    const zeros = 8 - left.length - right.length;
    if ((halves.length === 1 && zeros !== 0) || zeros < 0) return null;
    return [...left, ...Array(zeros).fill(0), ...right];
  }
}
