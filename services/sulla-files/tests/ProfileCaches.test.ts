// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { OrgRootKeyCache, OrgRootKeyUnavailableError } from '../src/cloudSync/OrgRootKeyCache.js';
import { ProfileCaches } from '../src/ProfileCaches.js';
import { ProfileIdentity } from '../src/ProfileIdentity.js';

/** A cache whose partition follows the principal Files is currently serving. */
function harness(initialUser: string) {
  let user = initialUser;
  const roots = new OrgRootKeyCache(() => ProfileIdentity.fromCloudUserId(user));
  const caches = new ProfileCaches([roots], () => user);
  const holds = async (principal: string) => {
    const saved = user; user = principal;
    try { await roots.get('org-collection', 1); return true }
    catch (error) { if (error instanceof OrgRootKeyUnavailableError) return false; throw error }
    finally { user = saved }
  };
  const install = (principal: string) => { const saved = user; user = principal; roots.set('org-collection', 1, Buffer.alloc(32, 0x5a)); user = saved };
  return { roots, caches, holds, install, setUser: (next: string) => { user = next }, currentUser: () => user };
}

describe('ProfileCaches', () => {
  it('invalidate-current drops the adopted principal and the desktop-user partition, leaving other principals alone', async () => {
    // risk: key lifecycle — sign-out must leave no org root for the signed-out principal, including pre-adoption roots.
    const h = harness('principal-alice');
    h.install('desktop-user'); h.install('principal-alice'); h.install('principal-bob');
    h.caches.invalidateCurrent();
    expect(await h.holds('principal-alice')).toBe(false);
    expect(await h.holds('desktop-user')).toBe(false);
    expect(await h.holds('principal-bob')).toBe(true); // tenant isolation: another principal's partition is untouched
  });

  it('principal change zeroizes the previous principal partition and keeps the new one', async () => {
    // risk: key lifecycle — roots installed under the sentinel must not survive adoption into a principal.
    const h = harness('desktop-user');
    h.install('desktop-user');
    h.setUser('principal-alice');
    h.install('principal-alice');
    h.caches.invalidatePrincipal('desktop-user');
    expect(await h.holds('desktop-user')).toBe(false);
    expect(await h.holds('principal-alice')).toBe(true);
  });
});
