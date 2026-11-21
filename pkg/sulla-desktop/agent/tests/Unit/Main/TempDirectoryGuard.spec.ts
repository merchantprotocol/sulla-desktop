// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ensureReliableTempEnvironment, MAC_LOCAL_TEMP_FALLBACK } from '@pkg/main/startup/tempDirectoryGuard';

describe('ensureReliableTempEnvironment', () => {
  it('moves inherited temp variables off an external macOS volume', () => {
    const env = { TMPDIR: '/Volumes/External/cache', TMP: '/Volumes/Other/tmp', TEMP: '/private/var/folders/local' };
    const usable = vi.fn(() => true);

    expect(ensureReliableTempEnvironment(env, 'darwin', usable)).toBe(true);
    expect(env).toEqual({ TMPDIR: MAC_LOCAL_TEMP_FALLBACK, TMP: MAC_LOCAL_TEMP_FALLBACK, TEMP: '/private/var/folders/local' });
    expect(usable).toHaveBeenCalledTimes(1);
  });

  it('replaces a missing or unwritable inherited temp directory', () => {
    const env = { TMPDIR: '/private/var/folders/missing', TMP: '/private/tmp' };

    expect(ensureReliableTempEnvironment(env, 'darwin', candidate => candidate === '/private/tmp')).toBe(true);
    expect(env.TMPDIR).toBe(MAC_LOCAL_TEMP_FALLBACK);
    expect(env.TMP).toBe('/private/tmp');
  });

  it('preserves valid local macOS temp directories and absent variables', () => {
    const env = { TMPDIR: '/private/var/folders/user/T/' };

    expect(ensureReliableTempEnvironment(env, 'darwin', () => true)).toBe(false);
    expect(env).toEqual({ TMPDIR: '/private/var/folders/user/T/' });
  });

  it('does not change temp variables on other platforms', () => {
    const env = { TMPDIR: '/Volumes/External/cache' };

    expect(ensureReliableTempEnvironment(env, 'linux', () => false)).toBe(false);
    expect(env.TMPDIR).toBe('/Volumes/External/cache');
  });
});
