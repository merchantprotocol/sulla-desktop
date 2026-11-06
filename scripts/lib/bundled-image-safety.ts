// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { createGunzip } from 'zlib';

import tar from 'tar-stream';

import { blobPath, type BundledImageLock } from '../../pkg/sulla-desktop/backend/bundledImages';

const THIN_MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const MACH_CPU_TYPES = new Set([7, 12, 18, 0x01000007, 0x0100000c, 0x01000012]);
const NESTED_ARCHIVE = /(?:\.tar|\.tar\.gz|\.tgz|\.gz)$/i;
const NESTED_COMPRESSED = /(?:\.tar\.gz|\.tgz|\.gz)$/i;
const PACKAGE_CACHE = /(?:^|\/)(?:\.cache\/yarn|\.npm\/_cacache)(?=\/|$)/;
const GZIP_MEDIA_TYPE = /\+gzip$/;
const ZSTD_MEDIA_TYPE = /\+zstd$/;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const INSPECTION_PREFIX_BYTES = 265;

export interface BundledImageSafetyFinding {
  image: string;
  layer: string;
  path:  string;
  reason: 'Mach-O binary' | 'package-manager cache';
  level:  'error' | 'warning';
}

export interface BundledImageSafetyScannerOptions {
  maxDepth?:      number;
  maxEntryBytes?: number;
  temporaryRoot?: string;
}

/** Inspects OCI filesystem layers for host binaries Apple will inspect during notarization. */
export class BundledImageSafetyScanner {
  private readonly maxDepth: number;
  private readonly maxEntryBytes: number;
  private readonly temporaryRoot: string;

  constructor(options: BundledImageSafetyScannerOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async scan(imagesDir: string, lock: BundledImageLock): Promise<BundledImageSafetyFinding[]> {
    const findings: BundledImageSafetyFinding[] = [];

    for (const image of lock.images) {
      for (const layer of image.layers) {
        if (ZSTD_MEDIA_TYPE.test(layer.mediaType)) {
          throw new Error(`bundled image safety check cannot inspect ${ image.name } ${ layer.digest }: unsupported OCI layer compression/mediaType ${ layer.mediaType }`);
        }
        const file = blobPath(imagesDir, layer.digest);
        const input = fs.createReadStream(file).pipe(GZIP_MEDIA_TYPE.test(layer.mediaType) ? createGunzip() : new PassThrough());

        await this.scanTarStream(input, image.name, layer.digest, '', 0, findings);
      }
    }

    return findings;
  }

  async scanTarBuffer(buffer: Buffer, image: string, layer: string, prefix = ''): Promise<BundledImageSafetyFinding[]> {
    const findings: BundledImageSafetyFinding[] = [];
    const input = this.isGzip(buffer) ? Readable.from(buffer).pipe(createGunzip()) : Readable.from(buffer);

    await this.scanTarStream(input, image, layer, prefix, 0, findings);

    return findings;
  }

  private async scanTarFile(file: string, image: string, layer: string, prefix: string, depth: number, findings: BundledImageSafetyFinding[]): Promise<void> {
    await this.scanTarStream(fs.createReadStream(file), image, layer, prefix, depth, findings);
  }

  private async scanTarStream(
    input: Readable,
    image: string,
    layer: string,
    prefix: string,
    depth: number,
    findings: BundledImageSafetyFinding[],
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
      const nested = header.type === 'file' && NESTED_ARCHIVE.test(header.name);
      const compressed = nested && NESTED_COMPRESSED.test(header.name);
      const cacheMatch = PACKAGE_CACHE.exec(header.name);

      if (cacheMatch) {
        const cacheRoot = header.name.slice(0, cacheMatch.index + cacheMatch[0].length);

        if (!reportedCacheRoots.has(cacheRoot)) {
          reportedCacheRoots.add(cacheRoot);
          findings.push({ image, layer, path: prefix ? `${ prefix}!/${ cacheRoot }` : cacheRoot, reason: 'package-manager cache', level: 'warning' });
        }
      }

      void this.inspectEntry(stream, header.size ?? 0, nested, compressed, entryPath, image, layer, depth, findings)
        .then(next, error => extract.destroy(error as Error));
    });
    input.pipe(extract);
    await completed;
  }

  private async inspectEntry(
    stream: Readable,
    declaredSize: number,
    nested: boolean,
    compressed: boolean,
    entryPath: string,
    image: string,
    layer: string,
    depth: number,
    findings: BundledImageSafetyFinding[],
  ): Promise<void> {
    if (nested && depth >= this.maxDepth) {
      stream.resume();
      throw new Error(`bundled image safety check cannot inspect ${ image } ${ layer } ${ entryPath }: nested archive depth exceeds ${ this.maxDepth }`);
    }
    if (nested && !compressed && declaredSize > this.maxEntryBytes) {
      stream.resume();
      throw new Error(`bundled image safety check cannot inspect ${ image } ${ layer } ${ entryPath }: nested archive entry exceeds ${ this.maxEntryBytes } bytes`);
    }

    const temporaryDirectory = nested ? await fs.promises.mkdtemp(path.join(this.temporaryRoot, 'sulla-image-scan-')) : undefined;
    const temporaryFile = temporaryDirectory ? path.join(temporaryDirectory, 'archive') : undefined;
    const output = temporaryFile ? fs.createWriteStream(temporaryFile, { flags: 'wx' }) : undefined;
    let inspectionPrefix = Buffer.alloc(0);
    let totalBytes = 0;
    const inspectedStream = await this.decodeEntryStream(stream, compressed);

    try {
      for await (const rawChunk of inspectedStream) {
        const chunk = Buffer.from(rawChunk);

        totalBytes += chunk.length;
        if (inspectionPrefix.length < INSPECTION_PREFIX_BYTES) inspectionPrefix = Buffer.concat([inspectionPrefix, chunk]).subarray(0, INSPECTION_PREFIX_BYTES);
        if (nested && totalBytes > this.maxEntryBytes) {
          throw new Error(`bundled image safety check cannot inspect ${ image } ${ layer } ${ entryPath }: nested archive entry exceeds ${ this.maxEntryBytes } bytes`);
        }
        if (output && !output.write(chunk)) await new Promise<void>(resolve => output.once('drain', resolve));
      }
      if (output) await new Promise<void>(resolve => output.end(resolve));

      if (this.isMachO(inspectionPrefix)) findings.push({ image, layer, path: entryPath, reason: 'Mach-O binary', level: 'error' });
      if (temporaryFile && this.isTar(inspectionPrefix)) {
        await this.scanTarFile(temporaryFile, image, layer, entryPath, depth + 1, findings);
      }
    } finally {
      output?.destroy();
      if (temporaryDirectory) await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }


  private async decodeEntryStream(stream: Readable, compressed: boolean): Promise<Readable> {
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    if (first.done) return Readable.from([]);
    const input = Readable.from(this.prependChunk(Buffer.from(first.value), iterator as AsyncIterator<Uint8Array>));

    return compressed && this.isGzip(Buffer.from(first.value)) ? input.pipe(createGunzip()) : input;
  }

  private async *prependChunk(first: Buffer, iterator: AsyncIterator<Uint8Array>): AsyncGenerator<Buffer> {
    yield first;
    while (true) {
      const item = await iterator.next();

      if (item.done) return;
      yield Buffer.from(item.value);
    }
  }

  private isMachO(prefix: Buffer): boolean {
    if (prefix.length < 4) return false;
    const magic = prefix.subarray(0, 4).toString('hex');

    if (THIN_MACH_O_MAGICS.has(magic)) return true;
    if (prefix.length < 12) return false;

    const magicNumber = prefix.readUInt32BE(0);
    const littleEndian = magicNumber === FAT_CIGAM;

    if (magicNumber !== FAT_MAGIC && !littleEndian) return false;
    const architectureCount = littleEndian ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4);

    // cafebabe is also the Java class-file magic. A real fat Mach-O has a small
    // architecture count followed by a recognized Mach CPU type.
    if (architectureCount < 1 || architectureCount > 64) return false;
    return MACH_CPU_TYPES.has(littleEndian ? prefix.readUInt32LE(8) : prefix.readUInt32BE(8));
  }


  private isTar(prefix: Buffer): boolean {
    return prefix.length >= 262 && prefix.subarray(257, 262).toString('ascii') === 'ustar';
  }

  private isGzip(buffer: Buffer): boolean {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  }

}