// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Path-traversal-safe filesystem mutations for native Files roots. The implementation is split
// across Services/ (root path guard, pinned primitives, coordinator); this module keeps the
// public import path stable for watcher, file operations, journal and residency callers.
export { FilesMutationCoordinator } from './Services/FilesMutationCoordinator.js';
export { PinnedRegularFile } from './Services/PinnedRegularFile.js';
export type {
  DirectoryReceipt,
  EvictionReceipt,
  FileFingerprint,
  PublicationReceipt,
  ReplacementReceipt,
} from './Services/FileFingerprint.js';
