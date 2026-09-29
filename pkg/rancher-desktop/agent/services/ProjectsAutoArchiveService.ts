import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel } from '../database/models/WorkItemsModel';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_AFTER_HOURS = 24;

let projectsAutoArchiveServiceInstance: ProjectsAutoArchiveService | null = null;

export function getProjectsAutoArchiveService(): ProjectsAutoArchiveService {
  projectsAutoArchiveServiceInstance ??= new ProjectsAutoArchiveService();
  return projectsAutoArchiveServiceInstance;
}

/**
 * Keeps finished work off the Projects board: done/cancelled tasks are
 * soft-archived once they have been terminal for `projectsAutoArchiveDoneAfterHours`
 * (default 24; 0 disables). Archived rows stay recoverable.
 */
export class ProjectsAutoArchiveService {
  private initialized = false;
  private sweeping = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.sweep();
    this.timer = setInterval(() => {
      this.sweep().catch(err => console.error('[ProjectsAutoArchive] Sweep failed:', err));
    }, SWEEP_INTERVAL_MS);
    console.log('[ProjectsAutoArchive] Done-task auto-archive initialized');
  }

  destroy(): void {
    this.initialized = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const hours = Number(await SullaSettingsModel.get('projectsAutoArchiveDoneAfterHours', DEFAULT_AFTER_HOURS));
      if (!Number.isFinite(hours) || hours <= 0) return [];
      const ids = await WorkItemsModel.archiveCompletedTasks(hours);
      if (ids.length) console.log(`[ProjectsAutoArchive] Archived ${ ids.length } finished task(s) older than ${ hours }h`);
      return ids;
    } finally {
      this.sweeping = false;
    }
  }
}
