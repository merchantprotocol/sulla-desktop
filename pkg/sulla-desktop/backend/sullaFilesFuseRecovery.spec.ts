// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { decideFilesFuseRecovery, hashFilesFuseServiceDefinition, toFilesFuseContainerState } from './sullaFilesFuseRecovery';

const base = { containerState: 'running' as const, imageChanged: false, mountDead: false, nowMs: 100_000, restartCooldownMs: 30_000 };

describe('decideFilesFuseRecovery', () => {
  // risk: data integrity — regenerated Compose config must not tear down a live mount.
  it('does nothing for same image and config drift while running', () => {
    expect(decideFilesFuseRecovery(base)).toBe('none');
  });

  it('recreates only when the image changed', () => {
    expect(decideFilesFuseRecovery({ ...base, imageChanged: true })).toBe('recreate');
  });

  it('recreates when the stable adapter-owned definition changes', () => {
    expect(decideFilesFuseRecovery({ ...base, configChanged: true })).toBe('recreate');
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

describe('Files FUSE service definition hash', () => {
  const definition = { image: 'files-fuse:1', volumes: ['/mnt/files:/mnt/files:rshared', '/run/token:/token:ro'], environment: { URL: 'https://files', TOKEN: 'secret' }, cap_add: ['SYS_ADMIN'] };

  // risk: data integrity — unrelated compose regeneration must not recreate a live FUSE mount.
  it('is stable across regeneration-only metadata and ordering changes', () => {
    const before = hashFilesFuseServiceDefinition({ ...definition, labels: { generatedAt: 'today' }, generation: 1 });
    const regenerated = hashFilesFuseServiceDefinition({ ...definition, volumes: [...definition.volumes].reverse(), labels: { generatedAt: 'tomorrow' }, generation: 2 });

    expect(regenerated).toBe(before);
    expect(decideFilesFuseRecovery({ ...base, configChanged: regenerated !== before })).toBe('none');
  });

  // risk: data integrity — changed mount propagation/bind definitions must be applied.
  it('changes when an adapter bind changes', () => {
    const before = hashFilesFuseServiceDefinition(definition);
    const changed = hashFilesFuseServiceDefinition({ ...definition, volumes: ['/mnt/files:/mnt/files:rslave'] });

    expect(changed).not.toBe(before);
    expect(decideFilesFuseRecovery({ ...base, configChanged: changed !== before })).toBe('recreate');
  });
});

describe('toFilesFuseContainerState', () => {
  // risk: data integrity — a missing adapter must be created rather than silently left down.
  it('maps empty/missing inspect results to missing and recognizes known states', () => {
    expect(toFilesFuseContainerState('')).toBe('missing');
    expect(toFilesFuseContainerState('Error: No such object: sulla_files_fuse')).toBe('missing');
    expect(toFilesFuseContainerState('running')).toBe('running');
    expect(toFilesFuseContainerState('restarting')).toBe('restarting');
  });
});
