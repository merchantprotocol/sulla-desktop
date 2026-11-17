// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Pure startup decisions for image-pinned services and the optional Files adapter. */
export class SullaServiceStartupDecision {
  /** A bundled service must use this app's image ID; no pinned ID means no image-based action. */
  imageAction(runningImageId: string, pinnedImageId?: string): 'keep' | 'recreate' {
    return pinnedImageId && runningImageId.trim() !== pinnedImageId.trim() ? 'recreate' : 'keep';
  }

  /** An exited or missing FUSE adapter must be started before the mount can be restored. */
  fuseAction(containerState: string): 'start' | 'keep' {
    return containerState.trim().split(/\s+/, 1)[0] === 'running' ? 'keep' : 'start';
  }
}
