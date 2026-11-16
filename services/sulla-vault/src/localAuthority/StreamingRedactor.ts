// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Redacts credential values (and their Bearer/Bot/Token/URL-encoded forms) from a streamed
 * response, holding back just enough bytes to catch a secret split across chunks.
 * Moved verbatim from localAuthority.ts (E9).
 */
export class StreamingRedactor {
  private carry = Buffer.alloc(0);
  private readonly patterns: Buffer[];
  private readonly maxPattern: number;

  constructor(secrets: string[]) {
    const variants = new Set<string>();
    for (const secret of secrets) {
      if (!secret) continue;
      variants.add(secret);
      variants.add(`Bearer ${ secret }`);
      variants.add(`Bot ${ secret }`);
      variants.add(`Token ${ secret }`);
      variants.add(encodeURIComponent(secret));
    }
    this.patterns = [...variants].map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
    this.maxPattern = Math.max(1, ...this.patterns.map(pattern => pattern.length));
  }

  transform(chunk: Buffer, final = false): Buffer {
    const input = Buffer.concat([this.carry, chunk]);
    const output: Buffer[] = [];
    const stop = final ? input.length : Math.max(0, input.length - this.maxPattern + 1);
    let index = 0;
    while (index < stop) {
      const match = this.patterns.find(pattern => index + pattern.length <= input.length && input.subarray(index, index + pattern.length).equals(pattern));
      if (match) {
        output.push(Buffer.from('[REDACTED]'));
        index += match.length;
      } else {
        output.push(input.subarray(index, index + 1));
        index += 1;
      }
    }
    this.carry = final ? Buffer.alloc(0) : Buffer.from(input.subarray(index));
    return Buffer.concat(output);
  }

  flush(): Buffer {
    return this.transform(Buffer.alloc(0), true);
  }
}
