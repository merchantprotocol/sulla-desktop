// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface InstallIdFileSystem {
  readFileSync(file: string, encoding: 'utf8'): string;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void;
}

/** The anonymous per-install UUID stored in `<userData>/install-id`. */
export class InstallIdStore {
  static readonly FILE_NAME = 'install-id';

  constructor(
    private readonly userDataPath: string,
    private readonly files: InstallIdFileSystem = fs,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Return the install id, creating it on first use. Read errors other than ENOENT are thrown. */
  get(): string {
    const installIdPath = path.join(this.userDataPath, InstallIdStore.FILE_NAME);

    try {
      const existing = this.files.readFileSync(installIdPath, 'utf8').trim();

      if (existing) {
        return existing;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }

    const installId = this.newId();

    this.files.mkdirSync(this.userDataPath, { recursive: true });
    this.files.writeFileSync(installIdPath, installId, { encoding: 'utf8', mode: 0o600 });

    return installId;
  }
}
