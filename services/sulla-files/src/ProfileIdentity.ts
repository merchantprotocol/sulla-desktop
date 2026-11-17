// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

/** Scope used when no Cloud identity is bound (tests and unscoped callers). */
export const UNSCOPED_PROFILE_ID = 'profile_unscoped';

const PROFILE_ID = /^profile_[0-9a-f]{64}$/;

/**
 * Same derivation as ProfileCatalogEntry (packages/vault-profiles) and Desktop's OrgFilesProfileIdentity.
 * Local copy: the Files image does not ship packages/vault-profiles. Spec proves identical output.
 */
export class ProfileIdentity {
  static fromCloudUserId(cloudUserId: string): string {
    if (typeof cloudUserId !== 'string' || cloudUserId.trim().length === 0) throw new TypeError('cloudUserId is required');
    if (Buffer.byteLength(cloudUserId) > 256) throw new TypeError('cloudUserId is too long');
    return `profile_${ createHash('sha256').update(cloudUserId, 'utf8').digest('hex') }`;
  }

  static isProfileId(value: unknown): value is string {
    return typeof value === 'string' && PROFILE_ID.test(value);
  }
}
