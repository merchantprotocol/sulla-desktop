// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

/**
 * One owner-only file in ~/.sulla: the directory is 0700 and the file 0600, set on write and repaired on read.
 * Writes go to a 0600 temp file first, so a crash never leaves a half-written file at the real path.
 */
export class PrivateFile {
  static readonly DIR_MODE = 0o700;
  static readonly FILE_MODE = 0o600;

  constructor(private readonly directory: () => string, private readonly name: string, private readonly filesystem: typeof fs = fs) {}

  get path(): string { return path.join(this.directory(), this.name) }

  /** The file's text, or null only when it doesn't exist. Any other read error throws. */
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

  /**
   * Creates the file with `text` only if it does not exist yet: the temp file is hard-linked into place, which fails
   * with EEXIST when another writer got there first. Returns false (and changes nothing) in that case.
   */
  createExclusive(text: string): boolean {
    const tmp = this.writeTemp(text);
    try {
      this.filesystem.linkSync(tmp, this.path);

      return true;
    } catch (error: any) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    } finally {
      this.removeQuietly(tmp);
    }
  }

  /** Atomically replaces the file (temp file + rename). */
  replace(text: string): void {
    const tmp = this.writeTemp(text);
    try {
      this.filesystem.renameSync(tmp, this.path);
    } catch (error) {
      this.removeQuietly(tmp);
      throw error;
    }
  }

  private writeTemp(text: string): string {
    const dir = this.directory();
    this.filesystem.mkdirSync(dir, { recursive: true, mode: PrivateFile.DIR_MODE });
    this.tighten(dir, PrivateFile.DIR_MODE);
    const tmp = `${ this.path }.${ process.pid }.${ Date.now() }.${ Math.trunc(performance.now() * 1000) }.tmp`;
    try {
      this.filesystem.writeFileSync(tmp, text, { mode: PrivateFile.FILE_MODE, flag: 'wx' });
      this.filesystem.chmodSync(tmp, PrivateFile.FILE_MODE);
    } catch (error) {
      this.removeQuietly(tmp);
      throw error;
    }

    return tmp;
  }

  private removeQuietly(target: string): void {
    try { this.filesystem.rmSync(target, { force: true }) } catch { /* nothing left to clean */ }
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
