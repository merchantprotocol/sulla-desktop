// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { drainFilesAdapterLayers } from './guestMountInfo';

describe('Files mount layer draining', () => {
  it('detaches every identical propagated FUSE layer before returning', async() => {
    // risk: availability — a leftover dead duplicate would keep Files unusable after adapter restart.
    let layers = 2;
    const execCommand = vi.fn(async(_options:unknown, ...args:string[]) => {
      if (args[0] === 'cat') {
        const fuse = Array.from({ length: layers }, (_, i) => `${ 10 + i } 1 0:42 / /mnt/sulla/files rw - fuse.sulla-files sulla-files rw`);

        return fuse.join('\n');
      }
      if (args[0] === 'umount') layers--;
      return '';
    });

    await expect(drainFilesAdapterLayers({ execCommand } as any, '/mnt/sulla/files')).resolves.toBe(2);
    expect(execCommand.mock.calls.filter(call => call[1] === 'umount')).toHaveLength(2);
  });
});
