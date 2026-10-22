/** Files in the Sulla system collection under this prefix are use-case drafts. */
export { USE_CASE_PATH_PREFIX } from './systemPaths.js';
import { USE_CASE_PATH_PREFIX } from './systemPaths.js';

export function isUseCasePath(collection: { system_area?: string | null }, path: string): boolean {
  return collection.system_area !== 'logs' && collection.system_area !== 'training-data' && path.startsWith(USE_CASE_PATH_PREFIX);
}
