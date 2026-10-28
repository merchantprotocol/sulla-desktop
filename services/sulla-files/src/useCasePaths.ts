// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Files in the Sulla system collection under this prefix are use-case drafts. */
export { USE_CASE_PATH_PREFIX } from './systemPaths.js';
import { USE_CASE_PATH_PREFIX } from './systemPaths.js';

export function isUseCasePath(collection: { system_area?: string | null }, path: string): boolean {
  return collection.system_area !== 'logs' && path.startsWith(USE_CASE_PATH_PREFIX);
}
