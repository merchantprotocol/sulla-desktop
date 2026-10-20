/** Files in the Sulla system collection under this prefix are use-case drafts. */
export const USE_CASE_PATH_PREFIX = 'Use Cases/';

export function isUseCasePath(collection: { system_area?: string | null }, path: string): boolean {
  return collection.system_area === 'sulla' && path.startsWith(USE_CASE_PATH_PREFIX);
}
