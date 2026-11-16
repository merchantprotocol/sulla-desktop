// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const { linuxCreate, runtimeConstructed } = vi.hoisted(() => ({
  linuxCreate:        vi.fn(() => ({ backend: 'linux-docker' })),
  runtimeConstructed: vi.fn(),
}));

vi.mock('electron', () => ({ app: {}, net: {} }));
vi.mock('./linux/linuxVmBackend', () => ({ LinuxDockerBackend: { create: linuxCreate } }));
vi.mock('./sullaRuntimeBackend', () => ({
  default: class {
    backend = 'sulla-runtime';
    constructor(readonly arch: string) {
      runtimeConstructed(arch);
    }
  },
}));
vi.mock('./mock', () => ({ default: class { backend = 'mock' } }));
vi.mock('@pkg/utils/paths', () => ({ default: { appHome: '/home/u/.local/share/sulla-desktop' } }));

import factory from './factory';

describe('backend factory', () => {
  const originalMock = process.env.SULLA_MOCK_BACKEND;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SULLA_MOCK_BACKEND;
  });

  afterEach(() => {
    if (originalMock === undefined) delete process.env.SULLA_MOCK_BACKEND;
    else process.env.SULLA_MOCK_BACKEND = originalMock;
  });

  it('selects the Linux Docker backend on linux with the app-data directory', () => {
    expect(factory('x86_64', 'linux').backend).toBe('linux-docker');
    expect(linuxCreate).toHaveBeenCalledWith({ appDataDirectory: '/home/u/.local/share/sulla-desktop' });
    expect(runtimeConstructed).not.toHaveBeenCalled();
  });

  // risk: macOS regression — darwin must keep the VZ Sulla runtime, built with the caller's arch.
  it.each(['aarch64', 'x86_64'] as const)('keeps macOS (%s) on the Sulla runtime and never touches the Linux backend', (arch) => {
    const backend = factory(arch, 'darwin') as any;

    expect(backend.backend).toBe('sulla-runtime');
    expect(backend.arch).toBe(arch);
    expect(runtimeConstructed).toHaveBeenCalledTimes(1);
    expect(runtimeConstructed).toHaveBeenCalledWith(arch);
    expect(linuxCreate).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux', 'win32'] as const)('SULLA_MOCK_BACKEND=1 still wins on %s', (platform) => {
    process.env.SULLA_MOCK_BACKEND = '1';

    expect(factory('aarch64', platform).backend).toBe('mock');
    expect(linuxCreate).not.toHaveBeenCalled();
    expect(runtimeConstructed).not.toHaveBeenCalled();
  });

  it('still rejects Windows and other unsupported platforms', () => {
    expect(() => factory('x86_64', 'win32')).toThrow(/not supported/);
    expect(() => factory('x86_64', 'freebsd')).toThrow(/not supported/);
    expect(linuxCreate).not.toHaveBeenCalled();
    expect(runtimeConstructed).not.toHaveBeenCalled();
  });
});
