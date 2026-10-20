export const USE_CASE_PATH_PREFIX = 'Use Cases/';
export const MEMORY_PATH_PREFIX = 'Memory/';

export function isSullaWritablePath(path: string): boolean {
  return path.startsWith(USE_CASE_PATH_PREFIX) || path.startsWith(MEMORY_PATH_PREFIX);
}
