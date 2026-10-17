import schedule from 'node-schedule';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

const FILES_API = process.env.SULLA_FILES_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:30124';

let instance: SullaFilesMaintenanceService | undefined;
export class SullaFilesMaintenanceService {
  private job?:     schedule.Job;
  initialize(): void {
    if (this.job) return;
    this.job = schedule.scheduleJob('0 3 * * *', async() => {
      try {
        const token = await SullaSettingsModel.getServicePassword();
        const response = await fetch(`${ FILES_API }/v1/local/maintenance`, { method: 'POST', headers: { 'x-sulla-files-token': token }, signal: AbortSignal.timeout(30_000) });
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
