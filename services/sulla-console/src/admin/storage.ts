// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { readdir, stat, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Router } from 'express';

import { adminRoute, adminWrite, record } from './common.js';
import { startBackup } from './docker.js';
import type { RouteContext } from '../routes/helpers.js';

const DATA_DIR = process.env.SULLA_SERVER_DATA_DIR ?? '/var/lib/sulla-server';

function gb(bytes: number): number {
  return Math.round((bytes / 1_073_741_824) * 10) / 10;
}

async function diskTotal(): Promise<number> {
  try {
    const info = await statfs(DATA_DIR);
    return gb(Number(info.blocks) * Number(info.bsize));
  } catch {
    return 0;
  }
}

async function backupSettings(context: RouteContext): Promise<Record<string, unknown>> {
  const result = await context.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM sulla_console.audit_events
      WHERE kind='admin.backups.settings' ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0]?.details ?? {};
}

async function lastBackup() {
  try {
    const folder = resolve(DATA_DIR, 'files-backup');
    const entries = await readdir(folder, { withFileTypes: true });
    const candidates = await Promise.all(entries.filter(entry => entry.isFile()).map(async(entry) => {
      const info = await stat(resolve(folder, entry.name));
      return { at: info.mtime.toISOString(), sizeGb: gb(Number(info.size)), status: 'succeeded' };
    }));
    return candidates.sort((left, right) => right.at.localeCompare(left.at))[0] ?? null;
  } catch {
    return null;
  }
}

export function registerStorageRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/storage', adminRoute(async(_request, response) => {
    const total = await diskTotal();
    response.json({
      dataDir: DATA_DIR,
      diskTotalGb: total,
      volumes: [
        { name: 'Files', sizeGb: 0, unit: 'unavailable', detail: 'Organization files', source: 'sulla-files' },
        { name: 'Database', sizeGb: 0, unit: 'unavailable', detail: 'Server databases', source: 'sulla-postgres' },
        { name: 'Recipe volumes', sizeGb: 0, unit: 'unavailable', detail: 'Use case containers', source: 'Docker' },
      ],
    });
  }));

  router.get('/server/v1/backups', adminRoute(async(_request, response) => {
    const saved = await backupSettings(context);
    response.json({
      nightly: saved.nightly === true,
      time: process.env.SULLA_BACKUP_TIME ?? '2:00 AM',
      keep: Number(process.env.SULLA_BACKUP_KEEP ?? 14),
      destination: 'This server’s data folder',
      last: await lastBackup(),
    });
  }));

  router.put('/server/v1/backups', adminWrite(context, 'admin.backups.settings', async(request, response) => {
    response.json({ ok: true, settings: record(request.body) });
  }));

  router.post('/server/v1/backups/run', adminWrite(context, 'admin.backups.run', async(_request, response) => {
    await startBackup();
    response.status(202).json({ ok: true, status: 'started' });
  }));
}
