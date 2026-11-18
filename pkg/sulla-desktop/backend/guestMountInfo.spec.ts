// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import {
  anchorSharesParentPeerGroup, classifyFilesAnchor, drainFilesAdapterLayers, parseMountInfo, prepareSullaFilesGuestAnchor,
} from './guestMountInfo';

const ROOT_LINE = '1 0 0:1 / / rw - rootfs rootfs rw';
const MNT_LINE = '34 1 0:31 / /mnt rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw,mode=755';

/** Fake guest exec that serves a mutable /proc/self/mountinfo and records every root command. */
function fakeGuest(initialMountInfo: string[], bindAppends?: string) {
  const state = { mountInfo: [...initialMountInfo] };
  const commands: string[][] = [];
  const execCommand = vi.fn(async(_options:unknown, ...args:string[]) => {
    commands.push(args);
    if (args[0] === 'cat') return state.mountInfo.join('\n');
    if (args[0] === 'mount' && args[1] === '--bind' && bindAppends) state.mountInfo.push(bindAppends);
    return '';
  });

  return { exec: { execCommand } as any, commands, state };
}

const mountCommands = (commands: string[][]) => commands.filter(args => args[0] === 'mount');

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

    await expect(drainFilesAdapterLayers({ execCommand } as any, '/mnt/sulla/files')).resolves.toBeGreaterThanOrEqual(1);
    // Both stacked layers are gone, by two unmounts (plain, then lazy).
    expect(layers).toBe(0);
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
    const entries = parseMountInfo([
      '1 0 0:1 / / rw - rootfs rootfs rw',
      '603 1 0:31 /mnt/sulla /mnt/sulla rw - tmpfs tmpfs rw',
    ].join('\n'));

    expect(classifyFilesAnchor(entries, '/mnt/sulla').state).toBe('anchor');
  });

  it('refuses a fresh tmpfs mounted at /mnt/sulla', () => {
    // risk: data safety — never mistake an unrelated mount for our self-bind anchor.
    const entries = parseMountInfo([
      '34 1 0:31 / /mnt rw - tmpfs tmpfs rw',
      '603 34 0:31 / /mnt/sulla rw - tmpfs tmpfs rw',
    ].join('\n'));

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

describe('Files anchor peer group (duplicate FUSE layer fix)', () => {
  it('detects an anchor that shares its parent /mnt peer group', () => {
    // risk: availability — a shared peer id means rshared is a no-op and FUSE propagates onto the parent.
    const entries = parseMountInfo([
      ROOT_LINE,
      MNT_LINE,
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw',
    ].join('\n'));

    expect(anchorSharesParentPeerGroup(entries, '/mnt/sulla')).toBe(true);
  });

  it('leaves an anchor with its own peer id alone', () => {
    // risk: availability — re-peering a healthy anchor would cut rslave consumers' propagation.
    const entries = parseMountInfo([
      ROOT_LINE,
      MNT_LINE,
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:2 - tmpfs tmpfs rw',
    ].join('\n'));

    expect(anchorSharesParentPeerGroup(entries, '/mnt/sulla')).toBe(false);
  });

  it('re-peers an existing anchor that is in the /mnt peer group', async() => {
    // risk: availability — the duplicate FUSE layer comes from the anchor and /mnt sharing one group.
    const guest = fakeGuest([
      ROOT_LINE,
      MNT_LINE,
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw',
    ]);

    await expect(prepareSullaFilesGuestAnchor(guest.exec)).resolves.toBe('anchor');
    expect(mountCommands(guest.commands)).toEqual([
      ['mount', '--make-private', '/mnt/sulla'],
      ['mount', '--make-rshared', '/mnt/sulla'],
    ]);
  });

  it('issues no re-peer when the anchor already has its own peer group', async() => {
    // risk: availability — idempotent across Desktop restarts while the VM stays up; containers keep their binds.
    const guest = fakeGuest([
      ROOT_LINE,
      MNT_LINE,
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:2 - tmpfs tmpfs rw',
    ]);

    await expect(prepareSullaFilesGuestAnchor(guest.exec)).resolves.toBe('anchor');
    expect(mountCommands(guest.commands)).toEqual([
      ['mount', '--make-rshared', '/mnt/sulla'],
    ]);
  });

  it('re-peers a freshly self-bound anchor, which joins the /mnt group on bind', async() => {
    // risk: availability — the first boot path must end with the anchor in its own group, not /mnt's.
    const guest = fakeGuest(
      [ROOT_LINE, MNT_LINE],
      '603 34 0:31 /sulla /mnt/sulla rw,nosuid,nodev,relatime shared:1 - tmpfs tmpfs rw',
    );

    await expect(prepareSullaFilesGuestAnchor(guest.exec)).resolves.toBe('anchor');
    expect(mountCommands(guest.commands)).toEqual([
      ['mount', '--bind', '/mnt/sulla', '/mnt/sulla'],
      ['mount', '--make-private', '/mnt/sulla'],
      ['mount', '--make-rshared', '/mnt/sulla'],
    ]);
  });
});
