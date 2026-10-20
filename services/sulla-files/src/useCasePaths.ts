/** Files under this prefix are versioned use-case drafts until a human publishes them. */
export const USE_CASE_PATH_PREFIX = 'Sulla/Use Cases/';

export function isUseCasePath(path: string): boolean {
  return path.startsWith(USE_CASE_PATH_PREFIX);
}
