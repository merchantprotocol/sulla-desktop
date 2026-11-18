// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { BundledImage, BundledImagesDiskSpaceGuard } from './bundledImages';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** An image whose total bytes (bundledImageSize) are `bytes`. */
function imageOfSize(name: string, bytes: number): BundledImage {
  return {
    name,
    source:            `ghcr.io/merchantprotocol/${ name }:latest`,
    ref:               `ghcr.io/merchantprotocol/${ name }:sha-test`,
    sourceDigest:      `sha256:${ '0'.repeat(64) }`,
    manifestDigest:    `sha256:${ '1'.repeat(64) }`,
    manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
    manifestSize:      0,
    configDigest:      `sha256:${ '2'.repeat(64) }`,
    configSize:        0,
    layers:            [{ digest: `sha256:${ '3'.repeat(64) }`, size: bytes, mediaType: 'application/octet-stream' }],
  };
}

describe('BundledImagesDiskSpaceGuard', () => {
  // risk: availability — a low-space existing install must not block service startup when nothing is missing.
  it('warns but permits service startup when no bundled images need loading', async() => {
    const warn = vi.fn();
    const startServices = vi.fn();
    const guard = new BundledImagesDiskSpaceGuard(async() => 3.5 * GIB, warn);

    await guard.assertCanLoad([], 3);
    startServices();

    expect(warn).toHaveBeenCalledOnce();
    expect(startServices).toHaveBeenCalledOnce();
  });

  // risk: availability — an app update that adds one small image must load on an existing install with 9.8 GB free; blocking it leaves the Files mount down.
  it('permits an existing install to load one small missing image at 9.8 GB free', async() => {
    const warn = vi.fn();
    const guard = new BundledImagesDiskSpaceGuard(async() => 9.8 * GIB, warn);
    const files = imageOfSize('sulla-files-fuse', 300 * MIB);

    await expect(guard.assertCanLoad([files], 5)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  // risk: availability — blocking an existing install whose missing images need more space than is free avoids a half-written load that fails with no reason.
  it('throws with free and needed space when an existing install needs more than is free', async() => {
    const guard = new BundledImagesDiskSpaceGuard(async() => 9.8 * GIB, vi.fn());
    const big = imageOfSize('sulla-big', 5 * GIB);

    // 5 GiB archive x 2 + 2 GiB headroom = 12.0 GB needed.
    await expect(guard.assertCanLoad([big], 5)).rejects.toThrow(
      'Your Mac has 9.8 GB free. Sulla needs 12.0 GB to finish setting up. Free up space, then try again.',
    );
  });

  // risk: availability — a fresh install keeps the flat 10 GiB minimum so a Mac with little space stops with a clear reason.
  it('throws on a fresh install under 10 GiB free', async() => {
    const guard = new BundledImagesDiskSpaceGuard(async() => 3.5 * GIB, vi.fn());
    const small = imageOfSize('sulla-vault', 200 * MIB);
    const other = imageOfSize('sulla-core', 200 * MIB);

    // Every bundled image is missing: the flat 10 GB minimum applies.
    await expect(guard.assertCanLoad([small, other], 2)).rejects.toThrow(
      'Your Mac has 3.5 GB free. Sulla needs 10.0 GB to finish setting up. Free up space, then try again.',
    );
  });

  // risk: availability — sufficient disk must permit the initial image load.
  it('permits image loading when plenty of disk is available', async() => {
    const warn = vi.fn();
    const guard = new BundledImagesDiskSpaceGuard(async() => 12 * GIB, warn);
    const image = imageOfSize('sulla-vault', 200 * MIB);

    await expect(guard.assertCanLoad([image], 2)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
