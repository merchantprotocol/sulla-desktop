// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '../backend';
import type { ComposeServiceTarget } from '../sullaComposeContainers';
import { SullaServiceStartupDecision } from '../SullaServiceStartupDecision';

/**
 * After a running service finishes starting, pull its published image and
 * report whether the container is still on an older one. Failures keep the
 * running container.
 */
export class SullaServiceImageFreshness {
  constructor(
    private readonly guest: Pick<VMExecutor, 'execCommand'>,
    /** Service -> published image to pull and compare (live view of the backend's map). */
    private readonly refreshImages: ReadonlyMap<string, string>,
    /** Service -> image bundled with this app (live view of the backend's map). */
    private readonly pinnedImages: ReadonlyMap<string, string>,
    private readonly waitHealthy: (target: ComposeServiceTarget, timeoutSec: number, generation?: number) => Promise<void>,
    private readonly startupDecision = new SullaServiceStartupDecision(),
  ) {}

  async isStale(container: string, service: string, generation?: number): Promise<boolean> {
    await this.waitHealthy({ service, container }, 600, generation);
    const refreshImage = this.refreshImages.get(service);
    const pinnedImage = this.pinnedImages.get(service);

    if (!refreshImage && pinnedImage) {
      // Bundled with this app: the container must run exactly that image, never a
      // leftover (e.g. :latest from an older build). Nothing to pull: it is loaded.
      try {
        const [running, pinned] = await Promise.all([
          this.guest.execCommand({ capture: true, root: true }, 'docker', 'inspect', '--format', '{{.Image}}', container),
          this.guest.execCommand({ capture: true, root: true }, 'docker', 'image', 'inspect', '--format', '{{.Id}}', pinnedImage),
        ]);

        return this.startupDecision.imageAction(running, pinned) === 'recreate';
      } catch (error) {
        console.warn(`[Sulla] Could not compare ${ container } with its bundled image ${ pinnedImage }; keeping it:`, error);

        return false;
      }
    }
    if (!refreshImage) return false;
    try {
      await this.guest.execCommand({ root: true }, 'docker', 'pull', refreshImage);
      const [running, latest] = await Promise.all([
        this.guest.execCommand({ capture: true, root: true }, 'docker', 'inspect', '--format', '{{.Image}}', container),
        this.guest.execCommand({ capture: true, root: true }, 'docker', 'image', 'inspect', '--format', '{{.Id}}', refreshImage),
      ]);

      return this.startupDecision.imageAction(running, latest) === 'recreate';
    } catch (error) {
      console.warn(`[Sulla] Could not check ${ refreshImage } for ${ service }; keeping the running container:`, error);

      return false;
    }
  }
}
