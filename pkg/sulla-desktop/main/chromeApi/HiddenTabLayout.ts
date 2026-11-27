// SPDX-License-Identifier: GPL-2.0-or-later
import type { BrowserWindow, WebContents, WebContentsView } from 'electron';

import type { AgentViewport, AgentViewportPolicy } from '../browserTabs/AgentViewportPolicy';
import type { ParkedViewportEmulation } from '../browserTabs/ParkedViewportEmulation';

/** Park before attaching: even a brand new hidden tab must never cover the
 * renderer. Windowless function jobs can still navigate and evaluate. */
export class HiddenTabLayout {
  private readonly owners = new WeakMap<WebContentsView, BrowserWindow>();

  private readonly active = new WeakMap<WebContents, { uses: number; wasThrottled: boolean }>();

  constructor(private readonly viewports: AgentViewportPolicy, private readonly emulation: ParkedViewportEmulation) {}

  /** Reads may overlap captures. Only the last user may restore idle throttling. */
  async whileAwake<T>(wc: WebContents, run: () => Promise<T>): Promise<T> {
    let lease = this.active.get(wc);
    if (!lease) {
      lease = { uses: 0, wasThrottled: wc.getBackgroundThrottling() };
      wc.setBackgroundThrottling(false);
      this.active.set(wc, lease);
    }
    lease.uses++;
    try {
      return await run();
    } finally {
      if (--lease.uses === 0) {
        this.active.delete(wc);
        if (!wc.isDestroyed()) wc.setBackgroundThrottling(lease.wasThrottled);
      }
    }
  }

  prepare(view: WebContentsView, window: BrowserWindow | null, viewport?: AgentViewport): void {
    if (viewport !== undefined) this.viewports.set(view.webContents, viewport);
    const parked = this.viewports.parked(view.webContents);
    view.setBounds(parked);
    view.setVisible(true);
    try {
      if (window && !window.isDestroyed()) {
        this.owners.set(view, window);
        window.contentView.addChildView(view, 0);
      }
      this.emulation.apply(view.webContents, parked, true);
    } catch (error) {
      // A native attach can throw after it has partially modified the tree.
      this.detach(view);
      throw error;
    }
  }

  owner(view: WebContentsView): BrowserWindow | null {
    const owner = this.owners.get(view);
    return owner && !owner.isDestroyed() ? owner : null;
  }

  detach(view: WebContentsView): void {
    try { this.owner(view)?.contentView.removeChildView(view) } catch { /* already detached */ }
    this.owners.delete(view);
  }
}
