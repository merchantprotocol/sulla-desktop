// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { BundledImagesDiskSpaceGuard } from './bundledImages';

describe('BundledImagesDiskSpaceGuard', () => {
  // risk: availability — a low-space existing install must not block service startup.
  it('warns but permits service startup when no bundled images need loading', async() => {
    const warn = vi.fn();
    const startServices = vi.fn();
    const guard = new BundledImagesDiskSpaceGuard(async() => 3.5 * 1024 ** 3, warn);

    await guard.assertCanLoad(0);
    startServices();

    expect(warn).toHaveBeenCalledOnce();
    expect(startServices).toHaveBeenCalledOnce();
  });

  // risk: availability — do not proceed with image loading when free space is below the minimum.
  it('throws the actionable message when images are missing and disk is too low', async() => {
    const guard = new BundledImagesDiskSpaceGuard(async() => 3.5 * 1024 ** 3, vi.fn());

    await expect(guard.assertCanLoad(1)).rejects.toThrow(
      'Your Mac has 3.5 GB free. Sulla needs at least 10 GB to finish setting up. Free up space, then try again.',
    );
  });

  // risk: availability — sufficient disk must permit the initial image load.
  it('permits image loading when enough disk is available', async() => {
    const warn = vi.fn();
    const guard = new BundledImagesDiskSpaceGuard(async() => 12 * 1024 ** 3, warn);

    await expect(guard.assertCanLoad(1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
