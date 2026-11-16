// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { open } from 'node:fs/promises';

export type WritableFileHandle = Awaited<ReturnType<typeof open>>;

/** Positional writes that never accept a short write as success. */
export class ExactFileWriter {
  static async writeAll(handle:WritableFileHandle, value:Buffer, position:number):Promise<void> {
    let written = 0;
    while (written < value.length) {
      const result = await handle.write(value, written, value.length - written, position + written);
      if (!result.bytesWritten) throw new Error('Backup destination stopped accepting bytes');
      written += result.bytesWritten;
    }
  }
}
