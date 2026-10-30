// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import schedule from 'node-schedule';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { desktopFilesFetch, filesHttpsOrigin } from '@pkg/main/sullaFilesTls';

const FILES_API = process.env.SULLA_FILES_API_URL?.replace(/\/+$/, '');

let instance: SullaFilesMaintenanceService | undefined;
export class SullaFilesMaintenanceService {
  private job?:     schedule.Job;
  initialize(): void {
    if (this.job) return;
    this.job = schedule.scheduleJob('0 3 * * *', async() => {
      try {
        const token = await SullaSettingsModel.getServicePassword();
        const init = { method: 'POST', headers: { 'x-sulla-files-token': token }, signal: AbortSignal.timeout(30_000) };
        // Local Files only listens on pinned TLS; plain HTTP to the Files service always failed.
        const response = FILES_API ? await fetch(`${ FILES_API }/v1/local/maintenance`, init) : await desktopFilesFetch(`${ filesHttpsOrigin() }/v1/local/maintenance`, init);
        if (!response.ok) throw new Error(`Files maintenance returned ${ response.status }`);
        const result = await response.json() as { expiredFiles:number; deletedChunks:number };
        console.log(`[SullaFiles] nightly maintenance expired ${ result.expiredFiles } files and collected ${ result.deletedChunks } chunks`);
      } catch (error) {
        console.warn('[SullaFiles] nightly maintenance failed:', error);
      }
    }) ?? undefined;
  }

  shutdown(): void { this.job?.cancel(); this.job = undefined }
}
export function getSullaFilesMaintenanceService(): SullaFilesMaintenanceService {
  instance ??= new SullaFilesMaintenanceService();
  return instance;
}
