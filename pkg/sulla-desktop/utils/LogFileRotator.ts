// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

/** Rotates each active log into a bounded, numbered previous-run history. */
export class LogFileRotator {
  constructor(
    private readonly fileSystem: typeof fs = fs,
    private readonly maxBackups = 5,
    private readonly maxBytes = 500 * 1024,
  ) {}

  rotateDirectory(directory: string): void {
    let names: string[];
    try { names = this.fileSystem.readdirSync(directory) } catch { return }
    for (const name of names) {
      if (!name.endsWith('.log') || /\.\d+\.log$/.test(name)) continue;
      this.rotateFile(path.join(directory, name));
    }
  }

  private rotateFile(activePath: string): void {
    const stem = activePath.slice(0, -4);
    if (!this.fileSystem.existsSync(activePath)) return;
    for (let index = this.maxBackups; index > 1; index--) {
      const source = `${ stem }.${ index - 1 }.log`;
      const destination = `${ stem }.${ index }.log`;
      try {
        if (this.fileSystem.existsSync(destination)) this.fileSystem.unlinkSync(destination);
        if (!this.fileSystem.existsSync(source)) continue;
        this.fileSystem.renameSync(source, destination);
        this.capFile(destination);
      } catch {
        // A log file that cannot be rotated remains available for normal writes.
      }
    }
    const firstBackup = `${ stem }.1.log`;
    try {
      this.fileSystem.copyFileSync(activePath, firstBackup);
      this.capFile(firstBackup);
      this.fileSystem.writeFileSync(activePath, '');
    } catch {
      // Retain the active file if its previous-run copy could not be made.
    }
  }

  private capFile(filePath: string): void {
    try {
      const size = this.fileSystem.statSync(filePath).size;
      if (size <= this.maxBytes) return;
      const buffer = Buffer.alloc(this.maxBytes);
      const fd = this.fileSystem.openSync(filePath, 'r');
      try { this.fileSystem.readSync(fd, buffer, 0, this.maxBytes, size - this.maxBytes) } finally { this.fileSystem.closeSync(fd) }
      const newline = buffer.indexOf('\n');
      this.fileSystem.writeFileSync(filePath, newline >= 0 ? buffer.subarray(newline + 1) : buffer);
    } catch {
      // Retention must never stop the app from opening its log streams.
    }
  }
}
