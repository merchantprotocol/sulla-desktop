// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

export type WindowsPeArchitecture = 'x64' | 'arm64';

export interface PeArchitectureReader {
  readBinary(file: string): Buffer;
}

export class NodePeArchitectureReader implements PeArchitectureReader {
  readBinary(file: string): Buffer { return fs.readFileSync(file); }
}

/** Read the PE/COFF machine field; rejects scripts, truncation, and non-PE input. */
export function readPeArchitecture(binary: Buffer): WindowsPeArchitecture {
  if (binary.length < 0x40 || binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('missing DOS MZ header');
  const peOffset = binary.readUInt32LE(0x3c);

  if (peOffset > binary.length - 6 || binary.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('missing or truncated PE signature');
  }
  const machine = binary.readUInt16LE(peOffset + 4);

  if (machine === 0x8664) return 'x64';
  if (machine === 0xaa64) return 'arm64';
  throw new Error(`unsupported PE machine 0x${ machine.toString(16).padStart(4, '0')}`);
}

/** Audits Windows-specific binaries, including Electron native modules, against one host CPU. */
export class WindowsPeArchitectureAudit {
  private readonly reader: PeArchitectureReader;

  constructor(reader: PeArchitectureReader = new NodePeArchitectureReader()) {
    this.reader = reader;
  }

  problems(root: string, binaries: readonly string[], target: WindowsPeArchitecture): string[] {
    return binaries.flatMap((relative) => {
      const file = path.join(root, relative);

      try {
        const actual = readPeArchitecture(this.reader.readBinary(file));

        return actual === target ? [] : [`${ relative } has CPU ${ actual }, not ${ target }`];
      } catch (error) {
        return [`${ relative } is not a valid ${ target } PE binary: ${ error instanceof Error ? error.message : String(error)}`];
      }
    });
  }
}
