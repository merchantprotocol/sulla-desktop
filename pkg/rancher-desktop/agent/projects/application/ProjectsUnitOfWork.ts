import type { ProjectsRepositories } from './ProjectsRepositories';

/**
 * Caller-owned transaction boundary. The callback decides the complete atomic
 * operation; repositories cannot escape the transaction that created them.
 */
export interface ProjectsUnitOfWork {
  execute<T>(work: (repositories: ProjectsRepositories) => Promise<T>): Promise<T>;
}
