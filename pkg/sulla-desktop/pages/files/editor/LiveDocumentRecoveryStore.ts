// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Saved Automerge bytes for live documents that closed while disconnected, keyed by file id.
 * Switching editor tabs builds a new LiveDocument; it reloads the same CRDT history from here so
 * offline edits are not lost. One shared instance serves the renderer; tests inject their own.
 */
export class LiveDocumentRecoveryStore {
  /** The renderer-wide store LiveDocument uses unless a caller injects another. */
  static readonly shared = new LiveDocumentRecoveryStore();

  private readonly saved = new Map<string, Uint8Array>();

  get(fileId:string):Uint8Array | undefined { return this.saved.get(fileId) }

  set(fileId:string, bytes:Uint8Array):void { this.saved.set(fileId, bytes) }

  delete(fileId:string):void { this.saved.delete(fileId) }

  has(fileId:string):boolean { return this.saved.has(fileId) }
}
