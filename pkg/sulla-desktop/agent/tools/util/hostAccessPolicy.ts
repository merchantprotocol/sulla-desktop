// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Tool surfaces that directly operate macOS hardware, applications, or the
 *  VM supervisor. These must fail closed with the same Administrative Access
 *  gate as exechost. App-internal Desktop services (browser, settings, Files,
 *  etc.) are deliberately not host-machine execution. */
const HOST_ACCESS_CATEGORIES = new Set(['capture', 'secretary']);

export function toolRequiresHostAccess(category: string, name: string): boolean {
  return HOST_ACCESS_CATEGORIES.has(category) || (category === 'applescript' && name === 'applescript_execute');
}
