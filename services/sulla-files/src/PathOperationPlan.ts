// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PublicationReceipt } from './safeFilesystem.js';

/** Shapes of the durable files_path_operations journal used for native move/copy/remote-purge custody. */
export interface PathOperationPlanEntry {
  rootId: string;
  fileId: string;
  sourcePath: string;
  targetPath: string;
  stagePath: string;
  contentHash: string;
  kind: 'move' | 'copy';
}
export interface SerializedFingerprint { dev: string; ino: string; size: number; mtimeMs: number }
export interface RemotePurgePlan {
  kind:'remote-purge-v1'; rootId:string; collectionId:string; fileId:string;
  sourcePath:string; stagePath:string; versionId:string; revision:string;
  contentHash:string; fingerprint:SerializedFingerprint;
  lifecycleGeneration:number;
}
export interface PathOperationReceipt {
  fileId: string;
  stagePath: string;
  targetPath: string;
  published: true;
  fingerprint?: SerializedFingerprint;
}
export interface PathOperationRow {
  operation_id: string;
  state: 'planned' | 'publishing' | 'db-committed';
  plan: PathOperationPlanEntry[] | RemotePurgePlan;
  receipts: PathOperationReceipt[];
}

type Fingerprint = PublicationReceipt['fingerprint'];

/** File identity (dev/ino) plus content stamp (size/mtime), as stored in journal JSON. */
export class OperationFingerprint {
  static serialize(value:Fingerprint):SerializedFingerprint {
    return { dev: value.dev.toString(), ino: value.ino.toString(), size: value.size, mtimeMs: value.mtimeMs };
  }

  static deserialize(value:SerializedFingerprint):Fingerprint {
    if (!/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino) || !Number.isSafeInteger(value.size) || !Number.isSafeInteger(value.mtimeMs)) {
      throw new Error('Path operation publication receipt has an invalid fingerprint');
    }
    return { dev: BigInt(value.dev), ino: BigInt(value.ino), size: value.size, mtimeMs: value.mtimeMs };
  }

  static sameIdentity(left:Fingerprint, right:Fingerprint):boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  static same(left:Fingerprint, right:Fingerprint):boolean {
    return OperationFingerprint.sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
  }
}
