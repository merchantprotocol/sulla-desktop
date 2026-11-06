// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { createGunzip } from 'zlib';

import tar from 'tar-stream';

import { blobPath, type BundledImageLock } from '../../pkg/sulla-desktop/backend/bundledImages';

const MACH_O_MAGICS = ['feedface', 'feedfacf', 'cafebabe', 'cefaedfe', 'cffaedfe'] as const;
const NESTED_ARCHIVE = /(?:\.tar|\.tar\.gz|\.tgz)$/i;
const FORBIDDEN_CACHE = /(?:^|\/)(?:\.cache\/yarn|\.npm\/_cacache)(?=\/|$)/;

export interface BundledImageSafetyProblem {
  image: string;
  layer: string;
  path:  string;
  reason: 'Mach-O binary' | 'package-manager cache';
}

/** Inspects OCI filesystem layers for host binaries and caches Apple will unpack during notarization. */
export class BundledImageSafetyScanner {
  async scan(imagesDir: string, lock: BundledImageLock): Promise<BundledImageSafetyProblem[]> {
    const problems: BundledImageSafetyProblem[] = [];

    for (const image of lock.images) {
      for (const layer of image.layers) {
        const file = blobPath(imagesDir, layer.digest);

        await this.scanTarStream(
          fs.createReadStream(file).pipe(layer.mediaType.includes('gzip') ? createGunzip() : new PassThrough()),
          image.name,
          layer.digest,
          '',
          problems,
        );
      }
    }

    return problems;
  }

  async scanTarBuffer(buffer: Buffer, image: string, layer: string, prefix = ''): Promise<BundledImageSafetyProblem[]> {
    const problems: BundledImageSafetyProblem[] = [];
    const input = this.isGzip(buffer) ? Readable.from(buffer).pipe(createGunzip()) : Readable.from(buffer);

    await this.scanTarStream(input, image, layer, prefix, problems);

    return problems;
  }

  private async scanTarStream(
    input: Readable,
    image: string,
    layer: string,
    prefix: string,
    problems: BundledImageSafetyProblem[],
  ): Promise<void> {
    const extract = tar.extract();
    const reportedCacheRoots = new Set<string>();
    const completed = new Promise<void>((resolve, reject) => {
      extract.on('finish', resolve);
      extract.on('error', reject);
      input.on('error', reject);
    });

    extract.on('entry', (header, stream, next) => {
      const entryPath = prefix ? `${ prefix}!/${ header.name }` : header.name;
      const chunks: Buffer[] = [];
      let firstBytes = Buffer.alloc(0);
      const nested = header.type === 'file' && NESTED_ARCHIVE.test(header.name);

      const cacheMatch = FORBIDDEN_CACHE.exec(header.name);

      if (cacheMatch) {
        const cacheRoot = header.name.slice(0, cacheMatch.index + cacheMatch[0].length);

        if (!reportedCacheRoots.has(cacheRoot)) {
          reportedCacheRoots.add(cacheRoot);
          problems.push({ image, layer, path: prefix ? `${ prefix}!/${ cacheRoot }` : cacheRoot, reason: 'package-manager cache' });
        }
      }
      stream.on('data', (chunk: Buffer) => {
        if (firstBytes.length < 4) firstBytes = Buffer.concat([firstBytes, chunk]).subarray(0, 4);
        if (nested) chunks.push(chunk);
      });
      stream.on('error', error => extract.destroy(error));
      stream.on('end', () => {
        void (async() => {
          if (firstBytes.length === 4 && MACH_O_MAGICS.includes(firstBytes.toString('hex') as typeof MACH_O_MAGICS[number])) {
            problems.push({ image, layer, path: entryPath, reason: 'Mach-O binary' });
          }
          if (nested && chunks.length) {
            const nestedProblems = await this.scanTarBuffer(Buffer.concat(chunks), image, layer, entryPath);

            problems.push(...nestedProblems);
          }
        })().then(next, error => extract.destroy(error as Error));
      });
      stream.resume();
    });
    input.pipe(extract);
    await completed;
  }

  private isGzip(buffer: Buffer): boolean {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  }
}
