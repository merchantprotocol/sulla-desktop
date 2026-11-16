// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SignedIncrementalManifest } from './incremental.js';

export interface PruneEvidence { manifest:SignedIncrementalManifest; verifiedAt?:string; restoreVerifiedAt?:string }

/** Hourly/daily/weekly retention, promotion windows and the reference-safe garbage set. */
export class BackupRetentionPolicy {
  static readonly limits = {
    hourly: { count: 24, age: 24 * 60 * 60_000 },
    daily:  { count: 30, age: 30 * 24 * 60 * 60_000 },
    weekly: { count: 12, age: 12 * 7 * 24 * 60 * 60_000 },
  } as const;

  victims(manifests:SignedIncrementalManifest[], now = new Date()):SignedIncrementalManifest[] {
    const limits = BackupRetentionPolicy.limits;
    const victims:SignedIncrementalManifest[] = [];
    for (const tier of ['hourly', 'daily', 'weekly'] as const) {
      const values = manifests.filter(item => item.manifest.tier === tier).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
      victims.push(...values.filter((item, index) => index >= limits[tier].count || now.getTime() - Date.parse(item.manifest.createdAt) > limits[tier].age));
    }
    return victims;
  }

  /** Pruning is refused unless a newer snapshot has passed manifest and isolated-restore verification. */
  mayPrune(candidate:SignedIncrementalManifest, newer:PruneEvidence):boolean {
    return Boolean(newer.verifiedAt && newer.restoreVerifiedAt && newer.manifest.manifest.createdAt > candidate.manifest.createdAt);
  }

  /** Only objects no surviving manifest references can be collected. */
  unreferencedObjects(victims:SignedIncrementalManifest[], survivors:SignedIncrementalManifest[]):string[] {
    const keep = new Set(survivors.flatMap(item => item.manifest.entries.map(entry => entry.objectKey)));
    return [...new Set(victims.flatMap(item => item.manifest.entries.map(entry => entry.objectKey)))].filter(key => !keep.has(key));
  }

  /** Monday 00:00 UTC of the ISO week containing `now`. */
  isoWeekStart(now:Date):Date {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day;
  }

  /** A run promotes to daily/weekly unless that window already has a restore-verified copy. */
  promotionWindows(createdAt:Date):[ 'daily' | 'weekly', Date ][] {
    return [['daily', new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate()))], ['weekly', this.isoWeekStart(createdAt)]];
  }
}
