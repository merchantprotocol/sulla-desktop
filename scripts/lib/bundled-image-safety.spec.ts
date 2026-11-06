// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Buffer } from 'buffer';

import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';

import { BundledImageSafetyScanner } from './bundled-image-safety';

class TarFixtureBuilder {
  async build(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
    const pack = tar.pack();
    const chunks: Buffer[] = [];

    pack.on('data', chunk => chunks.push(chunk));
    for (const entry of entries) {
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name: entry.name }, entry.data, error => error ? reject(error) : resolve());
      });
    }
    pack.finalize();
    await new Promise<void>((resolve, reject) => {
      pack.on('end', resolve);
      pack.on('error', reject);
    });

    return Buffer.concat(chunks);
  }
}

describe('BundledImageSafetyScanner', () => {
  it('reports cache paths and Mach-O files inside nested package archives with image and layer attribution', async() => {
    // risk: release integrity — unsigned Mach-O files make Apple reject the complete signed app.
    const fixtures = new TarFixtureBuilder();
    const nested = await fixtures.build([{ name: 'package/bin/esbuild', data: Buffer.from('feedfacf0011', 'hex') }]);
    const layer = await fixtures.build([
      { name: 'usr/local/share/.cache/yarn/v6/esbuild/.yarn-tarball.tgz', data: nested },
      { name: 'app/linux-script', data: Buffer.from('#!/bin/sh\necho safe\n') },
    ]);
    const problems = await new BundledImageSafetyScanner().scanTarBuffer(layer, 'sulla-tools', 'sha256:bad');

    expect(problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ image: 'sulla-tools', layer: 'sha256:bad', reason: 'package-manager cache' }),
      expect.objectContaining({
        image: 'sulla-tools',
        layer: 'sha256:bad',
        path: 'usr/local/share/.cache/yarn/v6/esbuild/.yarn-tarball.tgz!/package/bin/esbuild',
        reason: 'Mach-O binary',
      }),
    ]));
  });

  it('accepts a Linux-only layer without package-manager caches', async() => {
    // risk: release availability — safe images must not be blocked from packaging.
    const layer = await new TarFixtureBuilder().build([
      { name: 'app/server.js', data: Buffer.from('console.log("safe")') },
      { name: 'app/node_modules/native-linux/addon.node', data: Buffer.from('7f454c4602010100', 'hex') },
    ]);

    await expect(new BundledImageSafetyScanner().scanTarBuffer(layer, 'safe-image', 'sha256:good')).resolves.toEqual([]);
  });
});
