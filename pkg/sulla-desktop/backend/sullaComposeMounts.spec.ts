// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { findHostBindMounts } from './sullaComposeMounts';

describe('compose guest bind source policy', () => {
  it('allows the Files shared parent, its descendants, and the legacy mount path', () => {
    // risk: availability — rejecting the parent bind prevents the FUSE mount from propagating into the adapter.
    expect(findHostBindMounts({ services: { files: { volumes: [
      '/mnt/sulla:/mnt/sulla:rslave',
      '/mnt/sulla/files:/mnt/sulla/files:rshared',
      '/mnt/sulla-files:/mnt/sulla-files:rslave',
    ] } } })).toEqual([]);
  });

  it('does not allow lookalike sibling paths as guest sources', () => {
    expect(findHostBindMounts({ services: { files: { volumes: ['/mnt/sulla-other:/mnt/sulla-other'] } } })).toEqual([
      { service: 'files', source: '/mnt/sulla-other' },
    ]);
  });
});
