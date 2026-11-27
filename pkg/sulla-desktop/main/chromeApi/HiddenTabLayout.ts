// SPDX-License-Identifier: GPL-2.0-or-later
import type { BrowserWindow, WebContentsView } from 'electron';

import type { AgentViewport, AgentViewportPolicy } from '../browserTabs/AgentViewportPolicy';

/** Park before attaching: even a brand new hidden tab must never cover the
 * renderer. Windowless function jobs can still navigate and evaluate. */
export class HiddenTabLayout {
  private readonly owners = new WeakMap<WebContentsView, BrowserWindow>();

  constructor(private readonly viewports: AgentViewportPolicy) {}

  prepare(view: WebContentsView, window: BrowserWindow | null, viewport?: AgentViewport): void {
    if (viewport !== undefined) this.viewports.set(view.webContents, viewport);
    view.setBounds(this.viewports.parked(view.webContents));
    if (!window || window.isDestroyed()) {
      const size = this.viewports.resolve(view.webContents);
      view.webContents.enableDeviceEmulation({
        screenPosition: 'desktop', viewPosition: { x: 0, y: 0 }, viewSize: size,
        screenSize: size, scale: 1, deviceScaleFactor: 0,
      });
      return;
    }
    window.contentView.addChildView(view, 0);
    this.owners.set(view, window);
  }

  owner(view: WebContentsView): BrowserWindow | null {
    const owner = this.owners.get(view);
    return owner && !owner.isDestroyed() ? owner : null;
  }

  detach(view: WebContentsView): void {
    this.owner(view)?.contentView.removeChildView(view);
    this.owners.delete(view);
  }
}
