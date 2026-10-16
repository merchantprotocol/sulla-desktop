import { hostname } from 'node:os';

import schedule from 'node-schedule';

import { postgresClient } from '../database/PostgresClient';
import { getSullaFilesRuntime, getSullaFilesService } from '../files/runtime';
import { SullaFilesSyncClient } from '../files/sync';

import type { ToolExecutionContext } from '../tools/executionContext';

let instance: SullaFilesMaintenanceService | undefined;
function backgroundContext(userId: string): ToolExecutionContext {
  const now = Math.floor(Date.now() / 1_000);

  return {
    v:          1,
    iss:        'sulla-desktop',
    aud:        'sulla-tools',
    sub:        userId,
    device_id:  hostname(),
    scopes:     ['files/*'],
    iat:        now,
    exp:        now + 3_600,
    jti:        `files-sync-${ Date.now() }`,
    request_id: `files-sync-${ Date.now() }`,
  };
}
export class SullaFilesMaintenanceService {
  private job?:     schedule.Job;
  private syncJob?: schedule.Job;
  initialize(): void {
    if (this.job) return;
    this.job = schedule.scheduleJob('0 3 * * *', async() => {
      try {
        const result = await getSullaFilesService().expireAndGc();
        console.log(`[SullaFiles] nightly maintenance expired ${ result.expiredFiles } files and collected ${ result.deletedChunks } chunks`);
      } catch (error) {
        console.warn('[SullaFiles] nightly maintenance failed:', error);
      }
    }) ?? undefined;
    const serverUrl = process.env.SULLA_FILES_SERVER_URL;
    if (serverUrl) {
      this.syncJob = schedule.scheduleJob('*/1 * * * *', async() => {
        try {
          const runtime = getSullaFilesRuntime();
          const client = new SullaFilesSyncClient(serverUrl, runtime.store, runtime.keyring, runtime.files, process.env.SULLA_FILES_INTERNAL_TOKEN);
          await client.discoverCollections(backgroundContext(process.env.SULLA_FILES_USER_ID ?? 'desktop-user'));
          const collections = await postgresClient.query<{ id: string; owner_user_id: string }>("SELECT id,owner_user_id FROM collections WHERE kind='knowledge' AND home='synced'");
          for (const collection of collections) await client.sync(backgroundContext(collection.owner_user_id), collection.id);
        } catch (error) { console.warn('[SullaFiles] background sync failed:', error) }
      }) ?? undefined;
    }
  }

  shutdown(): void { this.job?.cancel(); this.syncJob?.cancel(); this.job = undefined; this.syncJob = undefined }
}
export function getSullaFilesMaintenanceService(): SullaFilesMaintenanceService {
  instance ??= new SullaFilesMaintenanceService();
  return instance;
}
