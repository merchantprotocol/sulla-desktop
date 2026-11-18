// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { decideFilesFuseRecovery } from './sullaFilesFuseRecovery';

const base = { containerState: 'running' as const, imageChanged: false, mountDead: false, nowMs: 100_000, restartCooldownMs: 30_000 };

describe('decideFilesFuseRecovery', () => {
  // risk: data integrity — regenerated Compose config must not tear down a live mount.
  it('does nothing for same image and config drift while running', () => {
    expect(decideFilesFuseRecovery(base)).toBe('none');
  });

  it('recreates only when the image changed', () => {
    expect(decideFilesFuseRecovery({ ...base, imageChanged: true })).toBe('recreate');
  });

  it('creates a missing or non-restartable stopped container', () => {
    expect(decideFilesFuseRecovery({ ...base, containerState: 'missing' })).toBe('create');
    expect(decideFilesFuseRecovery({ ...base, containerState: 'exited' })).toBe('create');
    expect(decideFilesFuseRecovery({ ...base, containerState: 'dead' })).toBe('create');
  });

  // risk: data integrity — restart instead of recreation preserves the container while restoring a dead mount.
  it('restarts a running adapter only after an observed dead mount', () => {
    expect(decideFilesFuseRecovery({ ...base, mountDead: true })).toBe('restart');
    expect(decideFilesFuseRecovery(base)).toBe('none');
  });

  it('rate-limits restarts when Files or the mount flaps', () => {
    expect(decideFilesFuseRecovery({ ...base, mountDead: true, lastRestartMs: 80_001 })).toBe('none');
    expect(decideFilesFuseRecovery({ ...base, mountDead: true, lastRestartMs: 70_000 })).toBe('restart');
  });
});
