// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';

/**
 * Generates the install's shared service secret: 32 random bytes as
 * base64url (43 chars of A-Z a-z 0-9 - _). That alphabet is safe raw in
 * PostgreSQL URLs, env vars, HTTP headers and Docker Compose (no `$`, `@`,
 * `#`, `%` or `/`), unlike the old `!@#$%^&*()_+` password charset.
 */
export class ServiceSecretGenerator {
  constructor(
    private readonly randomBytes: (size: number) => Buffer = crypto.randomBytes,
    private readonly byteLength = 32,
  ) {}

  generate(): string {
    return this.randomBytes(this.byteLength).toString('base64url');
  }
}
