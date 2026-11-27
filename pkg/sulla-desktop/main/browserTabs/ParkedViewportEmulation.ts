// SPDX-License-Identifier: GPL-2.0-or-later
import type { WebContents } from 'electron';

import type { AgentViewport } from './AgentViewportPolicy';

interface RendererState {
  live:     boolean;
  desired?: AgentViewport;
  applied?: AgentViewport;
}

/** Electron 40's native emulation methods dereference a null GetView() before first commit or after renderer loss. */
export class ParkedViewportEmulation {
  private readonly states = new WeakMap<WebContents, RendererState>();

  track(wc: WebContents): void {
    if (this.states.has(wc) || wc.isDestroyed()) return;
    const state: RendererState = {
      live: !wc.isCrashed() && !wc.isLoadingMainFrame() && wc.getURL() !== '' && wc.getOSProcessId() > 0,
    };
    this.states.set(wc, state);
    const restore = () => {
      state.live = true;
      this.applyDesired(wc, state, true);
    };
    wc.on('did-navigate', restore);
    wc.on('dom-ready', restore);
    wc.on('did-finish-load', restore);
    wc.on('render-process-gone', () => {
      state.live = false;
      state.applied = undefined;
    });
    wc.on('destroyed', () => {
      state.live = false;
      state.desired = undefined;
      state.applied = undefined;
      this.states.delete(wc);
    });
  }

  apply(wc: WebContents, { width, height }: AgentViewport, force = false): void {
    this.track(wc);
    const state = this.states.get(wc);
    if (!state) return;
    state.desired = { width, height };
    this.applyDesired(wc, state, force);
  }

  private canEmulate(wc: WebContents, state: RendererState): boolean {
    return state.live && !wc.isDestroyed() && !wc.isCrashed();
  }

  private applyDesired(wc: WebContents, state: RendererState, force: boolean): void {
    const size = state.desired;
    if (!size || !this.canEmulate(wc, state)) return;
    if (!force && state.applied?.width === size.width && state.applied.height === size.height) return;
    wc.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 },
      viewSize: size, deviceScaleFactor: 0, scale: 1,
    });
    state.applied = size;
  }

  clear(wc: WebContents): void {
    const state = this.states.get(wc);
    if (!state) return;
    state.desired = undefined;
    if (state.applied && this.canEmulate(wc, state)) wc.disableDeviceEmulation();
    state.applied = undefined;
  }
}
