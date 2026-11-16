// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PrivateFile } from '../device/PrivateFile';
import type { PublishedSnapshotKey } from './OrgPermissionSnapshotTransport';

/** One member's cached snapshot. `text` is exactly what Cloud sent; it is re-verified on every use. */
export interface StoredOrgSnapshot {
  text:           string;
  fetchedAt:      string;
}

/** Everything the store keeps for one (org, user). The epoch high-water mark outlives the snapshot itself. */
export interface StoredOrgSnapshotEntry {
  snapshot:       StoredOrgSnapshot | null;
  /** Highest epoch ever accepted for this member; older snapshots are refused (rollback). */
  highWaterEpoch: number;
}

/** Where the offline permission snapshots and Cloud's published keys live. */
export interface OrgPermissionSnapshotStore {
  entry(orgId: string, userId: string): StoredOrgSnapshotEntry;
  saveSnapshot(orgId: string, userId: string, snapshot: StoredOrgSnapshot, epoch: number): void;
  /** Drops the snapshot (membership or device revoked) but keeps the high-water mark. */
  dropSnapshot(orgId: string, userId: string): void;
  keys(): PublishedSnapshotKey[];
  saveKeys(keys: PublishedSnapshotKey[]): void;
}

interface StoreFileShape {
  v:        1;
  keys:     PublishedSnapshotKey[];
  subjects: Record<string, StoredOrgSnapshotEntry>;
}

/**
 * `~/.sulla/org-permission-snapshots.json` (0600 in a 0700 directory, atomic replace). The snapshot is signed, so a
 * tampered file fails verification; the file only needs to be private, not secret. A corrupt file reads as empty.
 */
export class FileOrgPermissionSnapshotStore implements OrgPermissionSnapshotStore {
  static readonly FILE_NAME = 'org-permission-snapshots.json';

  constructor(private readonly file: PrivateFile) {}

  static in(directory: () => string): FileOrgPermissionSnapshotStore {
    return new FileOrgPermissionSnapshotStore(new PrivateFile(directory, FileOrgPermissionSnapshotStore.FILE_NAME));
  }

  entry(orgId: string, userId: string): StoredOrgSnapshotEntry {
    const found = this.load().subjects[this.key(orgId, userId)];

    return found ? { snapshot: found.snapshot ?? null, highWaterEpoch: found.highWaterEpoch ?? 0 } : { snapshot: null, highWaterEpoch: 0 };
  }

  saveSnapshot(orgId: string, userId: string, snapshot: StoredOrgSnapshot, epoch: number): void {
    const data = this.load();
    const key = this.key(orgId, userId);
    data.subjects[key] = { snapshot, highWaterEpoch: Math.max(epoch, data.subjects[key]?.highWaterEpoch ?? 0) };
    this.write(data);
  }

  dropSnapshot(orgId: string, userId: string): void {
    const data = this.load();
    const key = this.key(orgId, userId);
    data.subjects[key] = { snapshot: null, highWaterEpoch: data.subjects[key]?.highWaterEpoch ?? 0 };
    this.write(data);
  }

  keys(): PublishedSnapshotKey[] {
    return this.load().keys;
  }

  saveKeys(keys: PublishedSnapshotKey[]): void {
    const data = this.load();
    data.keys = keys;
    this.write(data);
  }

  private key(orgId: string, userId: string): string {
    return JSON.stringify([orgId, userId]);
  }

  private load(): StoreFileShape {
    const text = this.file.read();
    if (!text) return this.empty();
    try {
      const parsed = JSON.parse(text) as Partial<StoreFileShape>;
      if (parsed?.v !== 1 || !Array.isArray(parsed.keys) || typeof parsed.subjects !== 'object' || parsed.subjects === null) return this.empty();

      return { v: 1, keys: parsed.keys, subjects: parsed.subjects };
    } catch {
      return this.empty();
    }
  }

  private write(data: StoreFileShape): void {
    this.file.replace(JSON.stringify(data));
  }

  private empty(): StoreFileShape {
    return { v: 1, keys: [], subjects: {} };
  }
}

/** In-memory store for tests and for processes that must not touch disk. */
export class MemoryOrgPermissionSnapshotStore implements OrgPermissionSnapshotStore {
  private readonly subjects = new Map<string, StoredOrgSnapshotEntry>();
  private published: PublishedSnapshotKey[] = [];

  entry(orgId: string, userId: string): StoredOrgSnapshotEntry {
    return this.subjects.get(JSON.stringify([orgId, userId])) ?? { snapshot: null, highWaterEpoch: 0 };
  }

  saveSnapshot(orgId: string, userId: string, snapshot: StoredOrgSnapshot, epoch: number): void {
    const key = JSON.stringify([orgId, userId]);
    this.subjects.set(key, { snapshot, highWaterEpoch: Math.max(epoch, this.subjects.get(key)?.highWaterEpoch ?? 0) });
  }

  dropSnapshot(orgId: string, userId: string): void {
    const key = JSON.stringify([orgId, userId]);
    this.subjects.set(key, { snapshot: null, highWaterEpoch: this.subjects.get(key)?.highWaterEpoch ?? 0 });
  }

  keys(): PublishedSnapshotKey[] {
    return [...this.published];
  }

  saveKeys(keys: PublishedSnapshotKey[]): void {
    this.published = [...keys];
  }
}
