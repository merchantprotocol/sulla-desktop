// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

const { linuxCreate } = vi.hoisted(() => ({ linuxCreate: vi.fn(() => ({ backend: 'linux-docker' })) }));

vi.mock('./linux/linuxVmBackend', () => ({ LinuxDockerBackend: { create: linuxCreate } }));
vi.mock('./sullaRuntimeBackend', () => ({ default: class { backend = 'sulla-runtime' } }));
vi.mock('./mock', () => ({ default: class { backend = 'mock' } }));
vi.mock('@pkg/utils/paths', () => ({ default: { appHome: '/home/u/.local/share/sulla-desktop' } }));

import factory from './factory';

describe('backend factory', () => {
  it('selects the Linux Docker backend on linux with the app-data directory', () => {
    expect(factory('x86_64', 'linux').backend).toBe('linux-docker');
    expect(linuxCreate).toHaveBeenCalledWith({ appDataDirectory: '/home/u/.local/share/sulla-desktop' });
  });

  it('keeps macOS on the Sulla runtime and rejects unsupported platforms', () => {
    expect(factory('aarch64', 'darwin').backend).toBe('sulla-runtime');
    expect(() => factory('x86_64', 'win32')).toThrow(/not supported/);
  });
});
