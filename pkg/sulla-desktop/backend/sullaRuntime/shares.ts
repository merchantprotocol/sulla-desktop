// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

import type { SullaRuntimeShare } from './NativeRuntime';

/**
 * Host folders shared into the guest under short virtio-fs tags, at the same path.
 *
 * Only app-owned transport/cache roots cross the VM boundary. User home,
 * external volumes, and Darwin's broad temporary roots are Files-owned.
 *
 * `sourceRoot` is set only when running unpackaged from a source checkout: the
 * services are then built from `services/<name>/Dockerfile` inside the guest,
 * so the checkout must be visible there (read-only) at the same path.
 */
export function sullaRuntimeShareList(appDirs: string[], resources: string, sourceRoot?: string): SullaRuntimeShare[] {
  const locations = ['/tmp/sulla-desktop'];
  const readOnly = new Set([resources]);

  if (sourceRoot) {
    readOnly.add(sourceRoot);
  }
  for (const extraDir of [...(sourceRoot ? [sourceRoot] : []), ...appDirs, resources]) {
    const found = locations.some(loc => !path.relative(path.normalize(loc), path.normalize(extraDir)).startsWith('../'));

    if (!found) {
      locations.push(extraDir);
    }
  }

  return locations.map((location, index) => ({
    tag:      `sulla${ index }`,
    hostPath: location,
    readOnly: readOnly.has(location),
  }));
}
