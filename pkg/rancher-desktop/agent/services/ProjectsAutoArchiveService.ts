let projectsAutoArchiveServiceInstance: ProjectsAutoArchiveService | null = null;

export function getProjectsAutoArchiveService(): ProjectsAutoArchiveService {
  projectsAutoArchiveServiceInstance ??= new ProjectsAutoArchiveService();
  return projectsAutoArchiveServiceInstance;
}

/**
 * Compatibility lifecycle hook. The Projects service owns the archive timer
 * and threshold so only the database-owning process can schedule mutations.
 */
export class ProjectsAutoArchiveService {
  private initialized = false;
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initialized = true;
    console.log('[ProjectsAutoArchive] Scheduling delegated to the Projects service');
    return Promise.resolve();
  }

  destroy(): void {
    this.initialized = false;
  }

  sweep(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
