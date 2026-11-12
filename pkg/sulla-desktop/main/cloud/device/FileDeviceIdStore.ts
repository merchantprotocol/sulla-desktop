// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeviceId, type DeviceIdStore } from '@sulla/domain';

import { PrivateFile } from './PrivateFile';

/** Where installs before ~/.sulla/device-id kept the id (SullaSettings in Electron userData). */
export interface LegacyDeviceIdSource {
  read(): Promise<string | null>;
}

/**
 * `~/.sulla/device-id`: the id as plain text, no newline (the same bytes as before). Implements the domain
 * `DeviceIdStore`: null only when there is no id; a file that exists but can't be read throws, so the identity
 * service fails closed instead of minting a second id. A file holding an invalid id is returned as-is and the
 * service rejects it as `store_corrupt` (never silently replaced).
 *
 * Legacy migration: with no file, an id still in SullaSettings is copied into the file and used.
 */
export class FileDeviceIdStore implements DeviceIdStore {
  static readonly FILE_NAME = 'device-id';

  constructor(private readonly file: PrivateFile, private readonly legacy: LegacyDeviceIdSource | null = null) {}

  static in(directory: () => string, legacy: LegacyDeviceIdSource | null = null): FileDeviceIdStore {
    return new FileDeviceIdStore(new PrivateFile(directory, FileDeviceIdStore.FILE_NAME), legacy);
  }

  async read(): Promise<string | null> {
    const text = this.file.read();
    if (text !== null && text.trim()) return text.trim();
    if (text !== null) return null; // an empty file reads as absent; createIfAbsent fills it

    const legacy = await this.readLegacy();
    if (!legacy) return null;
    if (!this.file.createExclusive(legacy)) return this.file.read()?.trim() || null;

    return legacy;
  }

  async createIfAbsent(id: string): Promise<boolean> {
    if (this.file.createExclusive(id)) return true;
    // Only an empty file (an interrupted old write) may be replaced; a stored id never is.
    if (this.file.read()?.trim()) return false;
    this.file.replace(id);

    return true;
  }

  /** Sync peek for callers that must not create an id or touch the database. Null on any problem. */
  readExisting(): string | null {
    try {
      return this.file.read()?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The legacy store is best effort, as before: if the settings database can't be read the install is treated as
   * having no legacy id. Only a well-formed id is migrated.
   */
  private async readLegacy(): Promise<string | null> {
    if (!this.legacy) return null;
    try {
      const value = await this.legacy.read();

      return DeviceId.isValid(value) ? value : null;
    } catch {
      return null;
    }
  }
}
