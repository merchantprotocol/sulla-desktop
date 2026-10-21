export const USE_CASE_PATH_PREFIX = 'Use Cases/';
export const MEMORY_PATH_PREFIX = 'Memory/';
/** Shared working project folders (PROJECT.md, TASKS.md, ...). Any agent may update them. */
export const PROJECTS_PATH_PREFIX = 'Projects/';

export function isSullaWritablePath(path: string): boolean {
  return path.startsWith(USE_CASE_PATH_PREFIX) || path.startsWith(MEMORY_PATH_PREFIX) || path.startsWith(PROJECTS_PATH_PREFIX);
}
