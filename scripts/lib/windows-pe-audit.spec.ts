// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { readPeArchitecture, WindowsPeArchitectureAudit } from './windows-pe-audit';

function pe(machine: number, offset = 0x80): Buffer {
  const bytes = Buffer.alloc(offset + 6);

  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(offset, 0x3c);
  bytes.write('PE\0\0', offset, 'binary');
  bytes.writeUInt16LE(machine, offset + 4);

  return bytes;
}

describe('Windows PE architecture audit', () => {
  it('identifies the x64 and ARM64 PE machine codes', () => {
    expect(readPeArchitecture(pe(0x8664))).toBe('x64');
    expect(readPeArchitecture(pe(0xaa64))).toBe('arm64');
  });

  it('rejects scripts, malformed binaries, and unsupported machines', () => {
    expect(() => readPeArchitecture(Buffer.from('#!/bin/sh'))).toThrow(/MZ/);
    expect(() => readPeArchitecture(pe(0x014c))).toThrow(/unsupported PE machine/);
    const truncated = pe(0x8664);
    truncated.writeUInt32LE(0xffff, 0x3c);
    expect(() => readPeArchitecture(truncated)).toThrow(/PE signature/);
  });

  it('reports target CPU mismatch and malformed required resources', () => {
    const files = new Map([
      ['/app/resources/win32/sulla-runtime.exe', pe(0x8664)],
      ['/app/node_modules/addon.node', pe(0xaa64)],
      ['/app/resources/win32/helper.exe', Buffer.from('not a PE file')],
    ]);
    const audit = new WindowsPeArchitectureAudit({
      readBinary: file => {
        const value = files.get(file);

        if (!value) throw new Error('ENOENT');

        return value;
      },
    });

    expect(audit.problems('/app', [
      'resources/win32/sulla-runtime.exe',
      'node_modules/addon.node',
      'resources/win32/helper.exe',
      'resources/win32/missing.exe',
    ], 'x64')).toEqual([
      'node_modules/addon.node has CPU arm64, not x64',
      'resources/win32/helper.exe is not a valid x64 PE binary: missing DOS MZ header',
      'resources/win32/missing.exe is not a valid x64 PE binary: ENOENT',
    ]);
  });
});
