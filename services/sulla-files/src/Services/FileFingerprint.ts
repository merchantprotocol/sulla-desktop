// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface FileFingerprint { dev: bigint; ino: bigint; size: number; mtimeMs: number }
export interface EvictionReceipt { source: string; quarantine: string; fingerprint: FileFingerprint }
export interface PublicationReceipt { staged: string; target: string; fingerprint: FileFingerprint; rollback?:string }
export interface DirectoryReceipt { path:string; dev:string; ino:string }
export interface ReplacementReceipt { target: string; backup: string; targetFingerprint: FileFingerprint; backupFingerprint: FileFingerprint }

/** Inode identity and content fingerprint comparisons for pinned Files entries. */
export class FileFingerprints {
  static from(stats:{ dev: bigint; ino: bigint; size: bigint; mtimeMs: bigint }):FileFingerprint {
    const size = Number(stats.size); const mtimeMs = Number(stats.mtimeMs);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeMs)) throw new Error('File metadata exceeds safe bounds');
    return { dev: stats.dev, ino: stats.ino, size, mtimeMs };
  }

  static sameIdentity(left:FileFingerprint, right:FileFingerprint):boolean { return left.dev === right.dev && left.ino === right.ino }

  static sameFingerprint(left:FileFingerprint, right:FileFingerprint):boolean {
    return FileFingerprints.sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
  }
}
