// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt share-link passwords, encoded `salt:digest` (base64url), compared in constant time. */
export class SharePasswordHasher {
  hash(password:string):string {
    const salt = randomBytes(16); const digest = scryptSync(password, salt, 32);
    return `${ salt.toString('base64url') }:${ digest.toString('base64url') }`;
  }

  matches(password:string, encoded:string):boolean {
    const [salt, expected] = encoded.split(':');
    if (!salt || !expected) return false;
    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), 32); const expectedBytes = Buffer.from(expected, 'base64url');
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  }
}
