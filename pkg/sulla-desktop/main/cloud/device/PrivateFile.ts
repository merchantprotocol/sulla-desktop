// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

/**
 * One owner-only file in ~/.sulla: the directory is 0700 and the file 0600, both set on
 * write and repaired on read; writes are atomic (temp file + rename).
 */
export class PrivateFile {
  static readonly DIR_MODE = 0o700;
  static readonly FILE_MODE = 0o600;

  constructor(private readonly directory: () => string, private readonly name: string, private readonly filesystem: typeof fs = fs) {}

  get path(): string { return path.join(this.directory(), this.name) }

  /** The file's text, or null when it doesn't exist. Other read errors throw. */
  read(): string | null {
    let text: string;
    try {
      text = this.filesystem.readFileSync(this.path, 'utf-8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    this.repairPermissions();

    return text;
  }

  write(text: string): void {
    const dir = this.directory();
    this.filesystem.mkdirSync(dir, { recursive: true, mode: PrivateFile.DIR_MODE });
    this.tighten(dir, PrivateFile.DIR_MODE);
    const tmp = `${ this.path }.${ process.pid }.${ Date.now() }.tmp`;
    try {
      this.filesystem.writeFileSync(tmp, text, { mode: PrivateFile.FILE_MODE });
      this.filesystem.chmodSync(tmp, PrivateFile.FILE_MODE);
      this.filesystem.renameSync(tmp, this.path);
    } catch (error) {
      try { this.filesystem.rmSync(tmp, { force: true }) } catch { /* nothing left to clean */ }
      throw error;
    }
  }

  /** Best effort: a file we can read but not chmod (another owner) is still usable. */
  private repairPermissions(): void {
    try {
      this.tighten(this.directory(), PrivateFile.DIR_MODE);
      this.tighten(this.path, PrivateFile.FILE_MODE);
    } catch { /* not ours to change */ }
  }

  private tighten(target: string, mode: number): void {
    if (process.platform === 'win32') return;
    if ((this.filesystem.statSync(target).mode & 0o777) !== mode) this.filesystem.chmodSync(target, mode);
  }
}
