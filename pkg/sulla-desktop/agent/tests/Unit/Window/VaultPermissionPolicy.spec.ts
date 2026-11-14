// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { VaultPermissionPolicy } from '@pkg/window/vaultPermissionPolicy';

describe('VaultPermissionPolicy', () => {
  const policy = new VaultPermissionPolicy('https://vault.sulla.localhost:8443');

  it('lets the vault page write to the clipboard so Copy buttons work', () => {
    expect(policy.allows('clipboard-sanitized-write', 'https://vault.sulla.localhost:8443/vault/')).toBe(true);
  });

  // risk: permissions — no other capability is granted to the secret-bearing view
  it('denies every other permission, including clipboard reads', () => {
    for (const permission of ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal']) {
      expect(policy.allows(permission, 'https://vault.sulla.localhost:8443/vault/')).toBe(false);
    }
  });

  // risk: permissions — another origin loaded into the view cannot use the grant
  it('denies the clipboard to any other origin or a missing/garbled origin', () => {
    expect(policy.allows('clipboard-sanitized-write', 'https://evil.example/vault/')).toBe(false);
    expect(policy.allows('clipboard-sanitized-write', 'http://vault.sulla.localhost:8443/vault/')).toBe(false);
    expect(policy.allows('clipboard-sanitized-write', undefined)).toBe(false);
    expect(policy.allows('clipboard-sanitized-write', 'not a url')).toBe(false);
  });
});
