// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, jest, test } from '@jest/globals';

// The guest transport runs `<sullaRuntime> exec -- sh -c <kill>`; stand in a
// binary that exits 0 (kill confirmed) or 1 (not confirmed). Jest runs in ESM
// mode here, so mocks must be registered before a dynamic import.
let mockRuntime = '/bin/true';
jest.unstable_mockModule('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { get sullaRuntime() { return mockRuntime }, sullaHome: '/tmp', appHome: '/tmp' },
}));
jest.unstable_mockModule('electron', () => ({ __esModule: true, default: {} }));

const { getProviderExecutionTransport, remoteKillConfirmed } = await import('../ProviderExecutionTransport');

const request = (confirm: boolean) => ({
  context: { runtime: 'guest', provider: 'claude-code', conversationId: 'synthetic' } as any,
  process: { kill: () => true } as any,
  signal:  'KILL' as const,
  remotePidFile: '/tmp/sulla-claude-synthetic.pid',
  confirm,
});

describe('guest provider termination', () => {
  test('only exit 0 (gone) and 2 (no pidfile) confirm the remote process is gone', () => {
    expect(remoteKillConfirmed(0)).toBe(true);
    expect(remoteKillConfirmed(2)).toBe(true);
    expect(remoteKillConfirmed(3)).toBe(false);
    expect(remoteKillConfirmed(4)).toBe(false);
    expect(remoteKillConfirmed(null)).toBe(false);
  });

  test('a confirmed termination rejects when the remote kill is not confirmed', async() => {
    mockRuntime = '/bin/false';
    await expect(Promise.resolve(getProviderExecutionTransport().terminate(request(true)))).rejects.toThrow(/exited with code 1/);
  });

  test('a confirmed termination resolves when the remote kill succeeds', async() => {
    mockRuntime = '/bin/true';
    await expect(Promise.resolve(getProviderExecutionTransport().terminate(request(true)))).resolves.toBeUndefined();
  });

  test('best-effort termination never rejects', async() => {
    mockRuntime = '/bin/false';
    await expect(Promise.resolve(getProviderExecutionTransport().terminate(request(false)))).resolves.toBeUndefined();
  });
});
