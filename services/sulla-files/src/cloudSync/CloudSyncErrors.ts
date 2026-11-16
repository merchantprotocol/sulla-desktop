// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** A refusal the desktop-control routes return with its own status and short message. */
export class HttpStatusError extends Error {
  constructor(readonly status:number, message:string) { super(message) }
}

/** Error text kept in status/last_error. Never carries paths, names, keys or bodies. */
export class CloudSyncErrorText {
  static safe(error:unknown):string {
    const code = (error as { code?:unknown })?.code;
    if (code === 'FILE_OFFLINE') return 'Sulla Cloud is unreachable';
    if (code === 'FILE_BUSY') return 'Sulla Cloud is busy; retrying shortly';
    if (code === 'FILES_SYNC_INTEGRITY' || code === 'FILE_INTEGRITY') return `Integrity check failed: ${ String((error as Error).message).slice(0, 200) }`;
    return 'Cloud backup step failed';
  }
}
