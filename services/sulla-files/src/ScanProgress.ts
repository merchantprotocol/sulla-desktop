// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** In-memory progress of the current scan/sync, reported by LocalFilesManager.status(). */
export class ScanProgress {
  pendingFiles = 0;
  pendingBytes = 0;
  processedBytes = 0;
  totalBytes = 0;
  startedAt = 0;
  lastScanAt?:string;
  lastSyncAt?:string;

  begin(pendingFiles:number, totalBytes:number, now = Date.now()):void {
    this.pendingFiles = pendingFiles; this.totalBytes = totalBytes; this.pendingBytes = totalBytes; this.processedBytes = 0; this.startedAt = now;
  }

  advance(bytes:number):void {
    this.processedBytes += bytes; this.pendingBytes = Math.max(0, this.totalBytes - this.processedBytes); this.pendingFiles = Math.max(0, this.pendingFiles - 1);
  }

  finishScan(now = new Date()):void {
    this.pendingFiles = 0; this.pendingBytes = 0; this.processedBytes = this.totalBytes; this.lastScanAt = now.toISOString();
  }

  /** Seconds left at the observed rate, only while work is running. */
  estimatedSeconds(running:boolean, now = Date.now()):number | undefined {
    const elapsed = Math.max(0.001, (now - this.startedAt) / 1_000); const rate = this.processedBytes / elapsed;
    return running && rate > 0 ? Math.max(1, Math.ceil(this.pendingBytes / rate)) : undefined;
  }
}
