// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { ProfileCatalogEntry } from '../../../packages/vault-profiles/src/index.js';
import { ProfileIdentity } from '../src/ProfileIdentity.js';

describe('ProfileIdentity', () => {
  it('derives the same profile id as the vault-profiles catalog', () => {
    // risk: tenant isolation — Files and Desktop must key one account's org roots under the same profile id.
    for (const cloudUserId of ['member-1', 'user_2abc', 'desktop-user', 'ünïcode-id']) {
      expect(ProfileIdentity.fromCloudUserId(cloudUserId))
        .toBe(new ProfileCatalogEntry({ cloudUserId, displayLabel: 'x' }).profileId.value);
    }
  });

  it('rejects empty and oversized Cloud identities instead of deriving a shared profile', () => {
    // risk: tenant isolation — a blank identity must never collapse every account onto one profile.
    expect(() => ProfileIdentity.fromCloudUserId('   ')).toThrow('cloudUserId is required');
    expect(() => ProfileIdentity.fromCloudUserId('x'.repeat(257))).toThrow('cloudUserId is too long');
  });

  it('accepts only well-formed profile ids on the invalidation boundary', () => {
    // risk: key lifecycle — arbitrary strings must not be treated as profile scopes.
    expect(ProfileIdentity.isProfileId(ProfileIdentity.fromCloudUserId('member-1'))).toBe(true);
    expect(ProfileIdentity.isProfileId('profile_unscoped')).toBe(false);
    expect(ProfileIdentity.isProfileId('profile_' + 'A'.repeat(64))).toBe(false);
    expect(ProfileIdentity.isProfileId(undefined)).toBe(false);
  });
});
