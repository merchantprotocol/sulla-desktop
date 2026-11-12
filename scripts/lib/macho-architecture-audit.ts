// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import { MacBuildArchitecture, type MacBuildArch } from './mac-build-architecture';

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_NAMES: Record<number, MacBuildArch> = { [CPU_TYPE_X86_64]: 'x64', [CPU_TYPE_ARM64]: 'arm64' };

/** Reported for a Mach-O file this audit cannot read as 64-bit big/little-endian x64 or arm64 data: never passes. */
const UNSUPPORTED = 'unsupported';
const INVALID = 'invalid';

/**
 * Reads which CPU slices a file holds by parsing its Mach-O header; null when
 * it is not Mach-O. A recognized Mach-O it cannot fully read (32-bit,
 * byte-swapped, truncated) is reported as a non-matching slice, so the audit
 * fails closed instead of passing it.
 */
export class MachOArchitectureReader {
  /** Java class files also start with 0xcafebabe; their next field is the version (>= 45), a fat file's is a small count. */
  private static readonly MAX_FAT_ARCHS = 44;

  read(file: string): string[] | null {
    const header = Buffer.alloc(8);
    const fd = fs.openSync(file, 'r');

    try {
      const got = fs.readSync(fd, header, 0, 8, 0);

      if (got < 4) return null;

      const magic = header.readUInt32BE(0);
      const recognized = this.isRecognized(magic);

      // Magic with no room for the rest of the header: a cut-off Mach-O.
      if (recognized && got < 8) return [INVALID];

      // Thin 64-bit little-endian (what x64 and arm64 Macs write); cputype follows.
      if (magic === 0xcffaedfe) return [this.name(header.readUInt32LE(4))];
      // Universal (always big-endian): nfat_arch then 20-byte (32-bit) or 32-byte (64-bit) entries.
      if (magic === 0xcafebabe) return this.readFat(fd, header.readUInt32BE(4), 20);
      if (magic === 0xcafebabf) return this.readFat(fd, header.readUInt32BE(4), 32);
      // 32-bit, big-endian thin, or byte-swapped universal: valid Mach-O, but never x64/arm64 slices.
      if (recognized) return [UNSUPPORTED];

      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  private isRecognized(magic: number): boolean {
    return [
      0xcffaedfe, // 64-bit little-endian (supported when whole)
      0xcafebabe, 0xcafebabf, // universal (supported when whole)
      0xfeedface, 0xcefaedfe, // 32-bit, big and little endian
      0xfeedfacf, // 64-bit, big endian
      0xbebafeca, 0xbfbafeca, // universal, byte-swapped
    ].includes(magic);
  }

  private readFat(fd: number, count: number, entrySize: number): string[] | null {
    if (count > MachOArchitectureReader.MAX_FAT_ARCHS) return null;
    if (count < 1) return [INVALID];

    const table = Buffer.alloc(count * entrySize);

    // A table that runs past the end of the file is a damaged universal binary.
    if (fs.readSync(fd, table, 0, table.length, 8) < table.length) return [INVALID];

    return Array.from({ length: count }, (_, i) => this.name(table.readUInt32BE(i * entrySize)));
  }

  private name(cpuType: number): string {
    return CPU_NAMES[cpuType] ?? `cpu-0x${ cpuType.toString(16) }`;
  }
}

/**
 * Walks a packaged tree and reports every Mach-O file that does not include
 * the CPU being packaged. A universal file with the right slice passes.
 * Symlinks are never followed (a framework's Versions/Current would otherwise
 * be read twice, and a link out of the tree would be read from outside it):
 * the files they point at are audited where they actually live, and a link
 * that resolves outside the tree is reported because it cannot be verified.
 */
export class MachOArchitectureAudit {
  constructor(private readonly reader: MachOArchitectureReader = new MachOArchitectureReader()) {}

  problems(root: string, target: MacBuildArch): string[] {
    const want = MacBuildArchitecture.parse(target).node;
    const base = fs.realpathSync(root);
    const problems: string[] = [];

    this.walk(base, base, (file) => {
      const archs = this.reader.read(file);

      if (archs && !archs.includes(want)) {
        problems.push(`${ path.relative(base, file) } is ${ archs.join('+') }, not ${ want }`);
      }
    }, (link) => {
      problems.push(`${ path.relative(base, link) } is a symlink to a path outside the app and cannot be verified`);
    });

    return problems.sort();
  }

  private walk(directory: string, base: string, onFile: (file: string) => void, onEscape: (link: string) => void): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        if (this.escapes(full, base)) onEscape(full);
      } else if (entry.isDirectory()) {
        this.walk(full, base, onFile, onEscape);
      } else if (entry.isFile()) {
        onFile(full);
      }
    }
  }

  /** True when the link resolves to a real path outside `base`; a dangling link points at nothing to ship. */
  private escapes(link: string, base: string): boolean {
    let real: string;

    try {
      real = fs.realpathSync(link);
    } catch {
      return false;
    }

    return real !== base && !real.startsWith(base + path.sep);
  }
}
