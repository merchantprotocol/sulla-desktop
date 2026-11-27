// SPDX-License-Identifier: GPL-2.0-or-later
import type { WebContents } from 'electron';

export interface AgentViewport {
  width:  number;
  height: number;
}

/** A WebContents survives native-view replacement/transfer, but not tab closure.
 * Keying by it also isolates hidden tabs from user-supplied asset IDs. */
export class AgentViewportPolicy {
  private readonly overrides = new WeakMap<WebContents, AgentViewport>();

  validate(viewport: AgentViewport): AgentViewport {
    if (!viewport || !Number.isInteger(viewport.width) || viewport.width < 320 || viewport.width > 3840 ||
        !Number.isInteger(viewport.height) || viewport.height < 320 || viewport.height > 2160) {
      throw new Error('viewport requires integer width (320..3840) and height (320..2160) in CSS pixels');
    }
    return { width: viewport.width, height: viewport.height };
  }

  set(contents: WebContents, viewport: AgentViewport): void {
    this.overrides.set(contents, this.validate(viewport));
  }

  resolve(contents: WebContents, once?: AgentViewport): AgentViewport {
    if (once !== undefined) return this.validate(once);
    return { ...(this.overrides.get(contents) ?? { width: 1440, height: 900 }) };
  }

  parked(contents: WebContents): Electron.Rectangle {
    const size = this.resolve(contents);
    // Keep the entire surface outside the window, but near the tile cache.
    const PARK_MARGIN = 100;
    return { ...size, x: -(size.width + PARK_MARGIN), y: 0 };
  }
}
