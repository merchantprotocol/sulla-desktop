// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DeviceIdStore } from './DeviceIdentityPorts';
import { PrivateFile } from './PrivateFile';

/** `~/.sulla/device-id`: the id as plain text, no newline (same bytes as before D-ID-2). */
export class FileDeviceIdStore implements DeviceIdStore {
  static readonly FILE_NAME = 'device-id';

  constructor(private readonly file: PrivateFile) {}

  static in(directory: () => string): FileDeviceIdStore {
    return new FileDeviceIdStore(new PrivateFile(directory, FileDeviceIdStore.FILE_NAME));
  }

  /** Unreadable is treated like missing, as before; the caller decides what to do. */
  read(): string | null {
    try {
      const raw = this.file.read()?.trim();

      return raw || null;
    } catch {
      return null;
    }
  }

  write(id: string): void {
    this.file.write(id);
  }
}
