// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import schedule from 'node-schedule';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from '@pkg/main/sullaFilesTls';

export interface ScheduledMaintenanceJob { cancel():unknown }

/** Collaborators the nightly Files maintenance job needs; swapped in tests. */
export interface SullaFilesMaintenanceDependencies {
  scheduleJob(rule:string, run:() => Promise<void>):ScheduledMaintenanceJob | null | undefined;
  servicePassword():Promise<string>;
  /** Plain fetch, used only when SULLA_FILES_API_URL points at a development Files API. */
  fetch(input:string, init:RequestInit):Promise<Response>;
  /** Pinned-TLS fetch to the local Files service. */
  filesFetch(input:string, init:RequestInit):Promise<Response>;
  filesOrigin:string;
  /** SULLA_FILES_API_URL without trailing slashes, or undefined. */
  filesApi?:string;
  log(message:string):void;
  warn(message:string, error:unknown):void;
}

export class SullaFilesMaintenanceService {
  private job?:ScheduledMaintenanceJob;

  constructor(private readonly deps:SullaFilesMaintenanceDependencies = SullaFilesMaintenanceService.defaultDependencies()) {}

  static defaultDependencies():SullaFilesMaintenanceDependencies {
    return {
      scheduleJob:     (rule, run) => schedule.scheduleJob(rule, run),
      servicePassword: () => SullaSettingsModel.getServicePassword(),
      fetch:           (input, init) => fetch(input, init),
      filesFetch:      (input, init) => desktopFilesFetch(input, init),
      filesOrigin:     FILES_HTTPS_ORIGIN,
      filesApi:        process.env.SULLA_FILES_API_URL?.replace(/\/+$/, ''),
      log:             message => console.log(message),
      warn:            (message, error) => console.warn(message, error),
    };
  }

  initialize(): void {
    if (this.job) return;
    this.job = this.deps.scheduleJob('0 3 * * *', () => this.runNightly()) ?? undefined;
  }

  shutdown(): void { this.job?.cancel(); this.job = undefined }

  async runNightly():Promise<void> {
    try {
      const token = await this.deps.servicePassword();
      const init = { method: 'POST', headers: { 'x-sulla-files-token': token }, signal: AbortSignal.timeout(30_000) };
      // Local Files only listens on pinned TLS; plain HTTP to the Files TLS port always failed.
      const response = this.deps.filesApi ? await this.deps.fetch(`${ this.deps.filesApi }/v1/local/maintenance`, init) : await this.deps.filesFetch(`${ this.deps.filesOrigin }/v1/local/maintenance`, init);
      if (!response.ok) throw new Error(`Files maintenance returned ${ response.status }`);
      const result = await response.json() as { expiredFiles:number; deletedChunks:number };
      this.deps.log(`[SullaFiles] nightly maintenance expired ${ result.expiredFiles } files and collected ${ result.deletedChunks } chunks`);
    } catch (error) {
      this.deps.warn('[SullaFiles] nightly maintenance failed:', error);
    }
  }
}

/** Holds the one Files maintenance scheduler for the app process. */
export class SullaFilesMaintenanceServiceProvider {
  private instance?:SullaFilesMaintenanceService;

  constructor(private readonly factory:() => SullaFilesMaintenanceService = () => new SullaFilesMaintenanceService()) {}

  resolve():SullaFilesMaintenanceService {
    return this.instance ??= this.factory();
  }
}

export const sullaFilesMaintenanceServiceProvider = new SullaFilesMaintenanceServiceProvider();

/** Compatibility getter: sulla.ts dynamically imports this to start and stop the job. */
export function getSullaFilesMaintenanceService(): SullaFilesMaintenanceService {
  return sullaFilesMaintenanceServiceProvider.resolve();
}
