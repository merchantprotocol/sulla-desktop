// SPDX-License-Identifier: GPL-2.0-or-later
import type { WebContents } from 'electron';

import type { AgentViewport, AgentViewportPolicy } from './AgentViewportPolicy';

export interface CaptureOptions {
  viewport?: AgentViewport;
  scale?:    1 | 2;
  fullPage?: boolean;
  format?:   'jpeg' | 'png';
  quality?:  number;
}

export interface CaptureMetadata {
  viewport:         AgentViewport;
  displayDpr:       number | null;
  devicePixelRatio: number;
  fullPage:         boolean;
  capped:           boolean;
  cssHeight:        number;
}

export interface CapturedScreenshot {
  base64:    string;
  mediaType: string;
  metadata:  CaptureMetadata;
}

interface LayoutMetrics {
  cssContentSize:    { height: number };
  cssVisualViewport: { pageX: number; pageY: number; scale: number };
  cssLayoutViewport: { clientWidth: number };
}

/** Optional page decorations run inside the same layout and lock as capture. */
export interface CaptureOverlays {
  prepare(): Promise<void>;
  remove(): Promise<void>;
}

export class AgentScreenshotCapture {
  private readonly tails = new WeakMap<WebContents, Promise<void>>();

  constructor(private readonly viewports: AgentViewportPolicy) {}

  async capture(wc: WebContents, displayDpr: () => number | null, options: CaptureOptions = {}, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    const viewport = this.viewports.resolve(wc, options.viewport);
    const scale = options.scale === undefined ? 1 : options.scale;
    if (scale !== 1 && scale !== 2) throw new Error('scale must be 1 or 2');
    const previous = this.tails.get(wc) ?? Promise.resolve();
    const operation = previous.then(() => this.captureOne(wc, displayDpr(), viewport, scale, options, overlays));
    const tail = operation.then(() => {}, () => {});
    this.tails.set(wc, tail);
    try {
      return await operation;
    } finally {
      if (this.tails.get(wc) === tail) this.tails.delete(wc);
    }
  }

  /** Bound each awaited step rather than racing a whole transaction that could
   * resume after cleanup and install another override on a newly focused tab. */
  private async until<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out capturing browser viewport')), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async captureOne(wc: WebContents, displayDpr: number | null, viewport: AgentViewport, devicePixelRatio: 1 | 2,
    options: CaptureOptions, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    if (wc.isDestroyed()) throw new Error('Cannot capture a closed browser tab');
    const dbg = wc.debugger;
    let ownsAttachment = false;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
        ownsAttachment = true;
      } catch (error) {
        if (!dbg.isAttached()) throw error;
      }
    }

    // If DevTools replaces our session mid-capture, never clear/detach the successor.
    let detached = false;
    const onDetach = () => { detached = true };
    dbg.once('detach', onDetach);
    const deadline = Date.now() + 10_000;
    const command = (name: string, params?: Record<string, unknown>, until = deadline) => {
      if (detached || wc.isDestroyed()) throw new Error('Browser debugger disconnected');
      return this.until(dbg.sendCommand(name, params), until);
    };
    let overrideAttempted = false;
    let overlaysAttempted = false;
    try {
      const metrics = { ...viewport, deviceScaleFactor: devicePixelRatio, mobile: viewport.width <= 480 };
      overrideAttempted = true;
      await command('Emulation.setDeviceMetricsOverride', metrics);
      let layout: LayoutMetrics = await command('Page.getLayoutMetrics');
      // Legacy pages without a viewport meta tag use a ~980px layout under
      // mobile emulation. The caller requested CSS dimensions, not a zoomed-out
      // desktop page on a phone. Keep responsive media queries at that width.
      if (metrics.mobile && (layout.cssLayoutViewport.clientWidth > viewport.width || layout.cssVisualViewport.scale !== 1)) {
        await command('Emulation.setDeviceMetricsOverride', { ...metrics, mobile: false });
        layout = await command('Page.getLayoutMetrics');
      }
      if (overlays) {
        overlaysAttempted = true;
        await this.until(overlays.prepare(), deadline);
      }
      const fullPage = options.fullPage === true;
      const contentHeight = fullPage ? Math.ceil(layout.cssContentSize.height) : viewport.height;
      if (!Number.isFinite(contentHeight)) throw new Error('Browser reported an invalid content height');
      const requested = Math.max(viewport.height, contentHeight);
      // Limit decoded RGBA to 128 MiB and either physical dimension to 16k.
      const cssHeight = Math.min(requested, 16384 / devicePixelRatio,
        Math.floor(32 * 1024 * 1024 / (viewport.width * devicePixelRatio ** 2)));
      const format = options.format ?? 'jpeg';
      const { data } = await command('Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? { quality: options.quality ?? 80 } : {}),
        fromSurface: true, captureBeyondViewport: true,
        // Never let a 1x1 document/iframe host determine the visible frame.
        clip: { x: fullPage ? 0 : layout.cssVisualViewport.pageX, y: fullPage ? 0 : layout.cssVisualViewport.pageY,
          width: viewport.width, height: cssHeight, scale: 1 },
      });
      if (!data) throw new Error('Browser returned an empty screenshot');
      return { base64: data, mediaType: `image/${ format }`, metadata: {
        viewport, displayDpr, devicePixelRatio, fullPage, capped: requested > cssHeight, cssHeight,
      } };
    } finally {
      try {
        if (overlaysAttempted) await this.until(overlays!.remove(), Date.now() + 1000);
      } finally {
        try {
          if (overrideAttempted && !detached && !wc.isDestroyed()) {
            await command('Emulation.clearDeviceMetricsOverride', {}, Date.now() + 1000);
          }
        } finally {
          dbg.removeListener('detach', onDetach);
          if (ownsAttachment && !detached && !wc.isDestroyed() && dbg.isAttached()) dbg.detach();
        }
      }
    }
  }
}
