// SPDX-License-Identifier: GPL-2.0-or-later
import type { WebContents } from 'electron';

import type { AgentViewport } from './AgentViewportPolicy';

/** Native off-window bounds keep the view out of sight, but don't size its renderer. */
export class ParkedViewportEmulation {
  private readonly sizes = new WeakMap<WebContents, AgentViewport>();
  private readonly observed = new WeakSet<WebContents>();

  apply(wc: WebContents, { width, height }: AgentViewport, force = false): void {
    if (!this.observed.has(wc)) {
      // A renderer replacement (including reload after a crash) loses widget emulation.
      // No page calls on a dead process: restore on the new renderer's navigation.
      const restore = () => {
        const current = this.sizes.get(wc);
        if (current && !wc.isDestroyed()) this.apply(wc, current, true);
      };
      wc.on('did-navigate', restore);
      wc.on('dom-ready', restore);
      this.observed.add(wc);
    }
    const previous = this.sizes.get(wc);
    if (!force && previous?.width === width && previous.height === height) return;
    const size = { width, height };
    wc.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 },
      viewSize: size, deviceScaleFactor: 0, scale: 1,
    });
    this.sizes.set(wc, size);
  }

  clear(wc: WebContents): void {
    if (!this.sizes.has(wc)) return;
    wc.disableDeviceEmulation();
    this.sizes.delete(wc);
  }
}
