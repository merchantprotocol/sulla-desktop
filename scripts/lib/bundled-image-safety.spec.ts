// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Buffer } from 'buffer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';

import tar from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { BundledImageLock } from '../../pkg/sulla-desktop/backend/bundledImages';
import { BundledImageSafetyScanner, type BundledImageEntryStreamDecoder } from './bundled-image-safety';

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

class ScannerFixture {
  private readonly directories: string[] = [];
  readonly tar = new TarFixtureBuilder();

  async temporaryDirectory(): Promise<string> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bundled-image-safety-test-'));

    this.directories.push(directory);
    return directory;
  }

  async nestedArchive(depth: number, payload = Buffer.from('#!/bin/sh\n')): Promise<Buffer> {
    let archive = await this.tar.build([{ name: 'payload', data: payload }]);

    for (let index = 0; index < depth; index++) archive = await this.tar.build([{ name: `nested-${ index }.tar`, data: archive }]);
    return archive;
  }

  lock(mediaType: string, digest: string): BundledImageLock {
    return {
      version: 1,
      arch: 'amd64',
      images: [{
        name: 'zstd-image', source: 'example/image:latest', ref: 'example/image:pinned', sourceDigest: digest,
        manifestDigest: digest, manifestMediaType: 'application/vnd.oci.image.manifest.v1+json', manifestSize: 1,
        configDigest: digest, configSize: 1, layers: [{ digest, size: 1, mediaType }],
      }],
    };
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.directories.map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
  }
}

const fixture = new ScannerFixture();
afterEach(() => fixture.cleanup());

describe('BundledImageSafetyScanner', () => {
  it('fails Mach-O including FAT_CIGAM inside a nested tgz with full attribution', async() => {
    // risk: release integrity — unsigned Mach-O files make Apple reject the complete signed app.
    const fatCigam = Buffer.from('bebafeca0100000007000001', 'hex');
    const nested = gzipSync(await fixture.tar.build([{ name: 'package/bin/esbuild', data: fatCigam }]));
    const layer = await fixture.tar.build([{ name: 'usr/local/share/.cache/yarn/esbuild.tgz', data: nested }]);
    const findings = await new BundledImageSafetyScanner().scanTarBuffer(layer, 'sulla-tools', 'sha256:bad');

    expect(findings).toEqual(expect.arrayContaining([
      { image: 'sulla-tools', layer: 'sha256:bad', path: 'usr/local/share/.cache/yarn', reason: 'package-manager cache', level: 'warning' },
      {
        image: 'sulla-tools', layer: 'sha256:bad',
        path: 'usr/local/share/.cache/yarn/esbuild.tgz!/package/bin/esbuild', reason: 'Mach-O binary', level: 'error',
      },
    ]));
  });

  it('reports a cache-only layer as a warning without an error', async() => {
    // risk: release availability — harmless Linux caches must remain visible without blocking required pinned images.
    const layer = await fixture.tar.build([{ name: 'root/.npm/_cacache/content-v2/linux-package', data: Buffer.from('linux only') }]);
    const findings = await new BundledImageSafetyScanner().scanTarBuffer(layer, 'sulla-accounts', 'sha256:cache');

    expect(findings).toEqual([{
      image: 'sulla-accounts', layer: 'sha256:cache', path: 'root/.npm/_cacache', reason: 'package-manager cache', level: 'warning',
    }]);
    expect(findings.some(finding => finding.level === 'error')).toBe(false);
  });

  it('does not misclassify a Java class file as a fat Mach-O binary', async() => {
    // risk: release availability — cafebabe Java bytecode must not create a false notarization block.
    const javaClass = Buffer.from('cafebabe0000003d00110a0002000307', 'hex');
    const layer = await fixture.tar.build([{ name: 'app/Main.class', data: javaClass }]);

    await expect(new BundledImageSafetyScanner().scanTarBuffer(layer, 'java-image', 'sha256:java')).resolves.toEqual([]);
  });

  it('fails closed on a zstd layer and names the image, layer, and media type', async() => {
    // risk: release integrity — an unsupported compression format must never bypass inspection.
    const directory = await fixture.temporaryDirectory();
    const digest = `sha256:${ 'a'.repeat(64) }`;
    const mediaType = 'application/vnd.oci.image.layer.v1.tar+zstd';

    await expect(new BundledImageSafetyScanner().scan(directory, fixture.lock(mediaType, digest)))
      .rejects.toThrow(`zstd-image ${ digest }: unsupported OCI layer compression/mediaType ${ mediaType }`);
  });

  it('fails closed when nested archive depth exceeds the configured cap', async() => {
    // risk: release integrity — deeply nested payloads must not evade scanning.
    const layer = await fixture.nestedArchive(2);

    await expect(new BundledImageSafetyScanner({ maxDepth: 1 }).scanTarBuffer(layer, 'deep-image', 'sha256:deep'))
      .rejects.toThrow(/deep-image sha256:deep .*nested archive depth exceeds 1/);
  });

  it('removes its temporary spool when entry decoding rejects before yielding data', async() => {
    // risk: release availability — decoder failures must not leak large temporary spools across packaging retries.
    class RejectingEntryDecoder implements BundledImageEntryStreamDecoder {
      async decode(): Promise<never> {
        throw new Error('injected decode failure');
      }
    }

    const temporaryRoot = await fixture.temporaryDirectory();
    const layer = await fixture.tar.build([{ name: 'broken.tgz', data: Buffer.from('not an archive') }]);
    const scanner = new BundledImageSafetyScanner({ temporaryRoot, entryDecoder: new RejectingEntryDecoder() });

    await expect(scanner.scanTarBuffer(layer, 'broken-image', 'sha256:broken')).rejects.toThrow('injected decode failure');
    await expect(fs.promises.readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it('fails closed when a nested archive exceeds the configured entry-size cap', async() => {
    // risk: release availability — attacker-controlled archives must not exhaust build memory or disk.
    const nested = await fixture.tar.build([{ name: 'payload', data: Buffer.alloc(128) }]);
    const layer = await fixture.tar.build([{ name: 'large.tar', data: nested }]);

    await expect(new BundledImageSafetyScanner({ maxEntryBytes: 64 }).scanTarBuffer(layer, 'large-image', 'sha256:large'))
      .rejects.toThrow(/large-image sha256:large large\.tar: nested archive entry exceeds 64 bytes/);
  });
});
