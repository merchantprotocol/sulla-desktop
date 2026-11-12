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

/** Reads which CPU slices a file holds by parsing its Mach-O header; null when it is not Mach-O. */
export class MachOArchitectureReader {
  read(file: string): string[] | null {
    const header = Buffer.alloc(8);
    const fd = fs.openSync(file, 'r');

    try {
      if (fs.readSync(fd, header, 0, 8, 0) < 8) return null;

      const magic = header.readUInt32BE(0);

      // Thin 64-bit: little-endian host order 0xfeedfacf; cputype follows.
      if (magic === 0xcffaedfe) return [this.name(header.readUInt32LE(4))];
      // Universal (always big-endian): nfat_arch then 20-byte (32-bit) entries.
      if (magic === 0xcafebabe) return this.readFat(fd, header.readUInt32BE(4), 20);
      if (magic === 0xcafebabf) return this.readFat(fd, header.readUInt32BE(4), 32);
      // 32-bit or byte-swapped Mach-O never belongs in a 64-bit-only app.
      if ([0xfeedface, 0xcefaedfe, 0xfeedfacf].includes(magic)) return ['unsupported'];

      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  private readFat(fd: number, count: number, entrySize: number): string[] | null {
    // A Java class file also starts with 0xcafebabe; its "count" is the version and is large.
    if (count < 1 || count > 16) return null;

    const table = Buffer.alloc(count * entrySize);

    fs.readSync(fd, table, 0, table.length, 8);

    return Array.from({ length: count }, (_, i) => this.name(table.readUInt32BE(i * entrySize)));
  }

  private name(cpuType: number): string {
    return CPU_NAMES[cpuType] ?? `cpu-0x${ cpuType.toString(16) }`;
  }
}

/**
 * Walks a packaged tree and reports every Mach-O file that does not include
 * the CPU being packaged. A universal file with the right slice passes.
 */
export class MachOArchitectureAudit {
  constructor(private readonly reader: MachOArchitectureReader = new MachOArchitectureReader()) {}

  problems(root: string, target: MacBuildArch): string[] {
    const want = MacBuildArchitecture.parse(target).node;
    const problems: string[] = [];

    for (const file of this.files(root)) {
      const archs = this.reader.read(file);

      if (archs && !archs.includes(want)) {
        problems.push(`${ path.relative(root, file) } is ${ archs.join('+') }, not ${ want }`);
      }
    }

    return problems.sort();
  }

  private files(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) return this.files(full);

      return entry.isFile() ? [full] : [];
    });
  }
}
