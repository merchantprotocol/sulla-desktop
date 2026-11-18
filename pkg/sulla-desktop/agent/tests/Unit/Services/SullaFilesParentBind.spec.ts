// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { sullaFilesGuestBinds } from '../../../services/AgentContainerLauncher';

describe('agent Files mount propagation', () => {
  it('binds the stable parent as rslave, never the replaceable FUSE mount', () => {
    // risk: availability — a direct FUSE bind leaves long-lived agents on a dead superblock after adapter restart.
    expect(sullaFilesGuestBinds(true)).toEqual(['/mnt/sulla:/mnt/sulla:rslave']);
    expect(sullaFilesGuestBinds(true).some(bind => bind.startsWith('/mnt/sulla/files:'))).toBe(false);
  });

  it('omits the mount unless Desktop prepared the shared anchor', () => {
    expect(sullaFilesGuestBinds(false)).toEqual([]);
  });
});
