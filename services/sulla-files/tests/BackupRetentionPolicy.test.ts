// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes backup retention, promotion windows and the nightly schedule (pure; no I/O).
import { describe, expect, it } from 'vitest';
import { BackupRetentionPolicy } from '../src/backup/BackupRetentionPolicy.js';
import { NightlyBackupSchedule } from '../src/backup/NightlyBackupSchedule.js';
import type { IncrementalManifest, SignedIncrementalManifest } from '../src/backup/incremental.js';

const HOUR = 60 * 60_000;
const policy = new BackupRetentionPolicy();

function snapshot(id:string, tier:IncrementalManifest['tier'], createdAt:Date, objectKeys:string[] = []):SignedIncrementalManifest {
  return {
    manifest: {
      format: 'sulla-files-incremental-backup', version: 1, id, createdAt: createdAt.toISOString(), tier, postgresVersion: '16', snapshotId: '1:1:',
      migrations: [], tables: [], excludedTableData: {},
      entries: objectKeys.map(objectKey => ({ path: objectKey, type: 'encrypted-chunk', size: 1, sha256: 'a'.repeat(64), objectKey })),
    },
    signature: { algorithm: 'hmac-sha256', value: '' },
  };
}

describe('backup retention', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');

  // risk: data loss — retention keeps the newest 24 hourly copies and nothing older than a day.
  it('keeps the newest 24 hourly snapshots and expires older or over-age ones', () => {
    const hourly = Array.from({ length: 26 }, (_, index) => snapshot(`h${ index }`, 'hourly', new Date(now.getTime() - index * HOUR / 2)));
    const stale = snapshot('old', 'hourly', new Date(now.getTime() - 25 * HOUR));
    const victims = policy.victims([...hourly, stale], now).map(item => item.manifest.id).sort();
    expect(victims).toEqual(['h24', 'h25', 'old']);
  });

  // risk: data loss — tiers are independent: hourly churn never expires daily or weekly copies.
  it('applies each tier limit separately and never touches manual snapshots', () => {
    const daily = Array.from({ length: 31 }, (_, index) => snapshot(`d${ index }`, 'daily', new Date(now.getTime() - index * 24 * HOUR + HOUR)));
    const weekly = [snapshot('w-new', 'weekly', new Date(now.getTime() - 7 * 24 * HOUR)), snapshot('w-old', 'weekly', new Date(now.getTime() - 85 * 24 * HOUR))];
    const manual = snapshot('m', 'manual', new Date('2020-01-01T00:00:00Z'));
    expect(policy.victims([...daily, ...weekly, manual], now).map(item => item.manifest.id).sort()).toEqual(['d30', 'w-old']);
  });

  // risk: data loss — nothing is pruned unless a newer snapshot has passed both verifications.
  it('allows pruning only after a newer, manifest- and restore-verified snapshot', () => {
    const older = snapshot('a', 'hourly', new Date(now.getTime() - HOUR));
    const newer = snapshot('b', 'hourly', now);
    expect(policy.mayPrune(older, { manifest: newer, verifiedAt: 'x', restoreVerifiedAt: 'y' })).toBe(true);
    expect(policy.mayPrune(older, { manifest: newer, verifiedAt: 'x' })).toBe(false);
    expect(policy.mayPrune(older, { manifest: newer, restoreVerifiedAt: 'y' })).toBe(false);
    expect(policy.mayPrune(newer, { manifest: older, verifiedAt: 'x', restoreVerifiedAt: 'y' })).toBe(false);
  });

  // risk: data loss — an object still referenced by any surviving manifest must never be collected.
  it('collects only objects no surviving manifest references, once each', () => {
    const victims = [snapshot('a', 'hourly', now, ['k1', 'k2']), snapshot('b', 'hourly', now, ['k2', 'k3'])];
    const survivors = [snapshot('c', 'daily', now, ['k3', 'k4'])];
    expect(policy.unreferencedObjects(victims, survivors)).toEqual(['k1', 'k2']);
  });

  // risk: missed backups — daily/weekly promotion windows start at UTC midnight and ISO Monday.
  it('computes the UTC day and ISO-week promotion windows', () => {
    expect(policy.isoWeekStart(new Date('2026-11-16T23:59:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z'); // Monday
    expect(policy.isoWeekStart(new Date('2026-11-22T10:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z'); // Sunday
    expect(policy.isoWeekStart(new Date('2026-11-23T00:00:00Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(policy.promotionWindows(new Date('2026-11-19T15:30:00Z')).map(([tier, since]) => [tier, since.toISOString()]))
      .toEqual([['daily', '2026-11-19T00:00:00.000Z'], ['weekly', '2026-11-16T00:00:00.000Z']]);
  });
});

describe('nightly backup schedule', () => {
  // risk: missed backups — the watch loop must run at the next 02:00 local, never twice in one night.
  it('schedules the next 02:00 local strictly after now', () => {
    const at = (hours:number, minutes = 0) => { const value = new Date(2026, 10, 16, hours, minutes, 0, 0); return value };
    expect(NightlyBackupSchedule.nextRun(at(1, 59)).getTime()).toBe(new Date(2026, 10, 16, 2, 0, 0, 0).getTime());
    expect(NightlyBackupSchedule.nextRun(at(2, 0)).getTime()).toBe(new Date(2026, 10, 17, 2, 0, 0, 0).getTime());
    expect(NightlyBackupSchedule.nextRun(at(23, 30)).getTime()).toBe(new Date(2026, 10, 17, 2, 0, 0, 0).getTime());
  });

  it('sleeps until the next run, backs up, and repeats', async() => {
    const sleeps:number[] = []; let runs = 0; let now = new Date(2026, 10, 16, 1, 0, 0, 0);
    const schedule = new NightlyBackupSchedule(async() => {
      runs++; if (runs === 2) throw new Error('stop');
    }, () => now, async milliseconds => { sleeps.push(milliseconds); now = new Date(now.getTime() + milliseconds) });
    await expect(schedule.forever()).rejects.toThrow('stop');
    expect(runs).toBe(2);
    expect(sleeps[0]).toBe(HOUR);
    expect(sleeps[1]).toBe(24 * HOUR);
  });
});
