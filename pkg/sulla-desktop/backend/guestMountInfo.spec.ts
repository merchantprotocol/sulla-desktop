// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { classifyFilesAnchor, drainFilesAdapterLayers, parseMountInfo } from './guestMountInfo';

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


describe('Files anchor mount classification', () => {
  it('accepts self-bind anchors relative to a separately mounted /mnt', () => {
    // risk: availability — the VM's separate /mnt tmpfs must not prevent the Files FUSE adapter from starting.
    const entries = parseMountInfo([
      '34 1 0:31 / /mnt rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw,mode=755,inode64',
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw,mode=755,inode64',
    ].join('\n'));

    expect(entries.map(entry => [entry.mountId, entry.parentId])).toEqual([[34, 1], [603, 34]]);
    expect(classifyFilesAnchor(entries, '/mnt/sulla').state).toBe('anchor');
  });

  it('accepts self-bind anchors when /mnt is not a separate mount', () => {
    // risk: availability — preserve the existing mount layout used by other VMs.
    const entries = parseMountInfo('603 34 0:31 /mnt/sulla /mnt/sulla rw - tmpfs tmpfs rw');

    expect(classifyFilesAnchor(entries, '/mnt/sulla').state).toBe('anchor');
  });

  it('refuses a fresh tmpfs mounted at /mnt/sulla', () => {
    // risk: data safety — never mistake an unrelated mount for our self-bind anchor.
    const entries = parseMountInfo('603 34 0:31 / /mnt/sulla rw - tmpfs tmpfs rw');

    expect(classifyFilesAnchor(entries, '/mnt/sulla').state).toBe('unexpected');
  });

  it('continues to classify the Files FUSE adapter and legacy bind workaround', () => {
    // risk: availability — identify the adapter for safe draining and preserve Jonathon's existing bind mount.
    const adapter = parseMountInfo('603 34 0:31 / /mnt/sulla/files rw - fuse sulla-files rw');
    const workaround = parseMountInfo('604 34 0:31 /sulla-files /mnt/sulla/files rw - tmpfs tmpfs rw');

    expect(classifyFilesAnchor(adapter, '/mnt/sulla/files').state).toBe('adapter');
    expect(classifyFilesAnchor(workaround, '/mnt/sulla/files').state).toBe('anchor');
  });
});
