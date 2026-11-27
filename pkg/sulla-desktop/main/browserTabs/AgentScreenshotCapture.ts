// SPDX-License-Identifier: GPL-2.0-or-later
import type { WebContents } from 'electron';

import type { AgentViewport } from './AgentViewportPolicy';

export interface CaptureOptions {
  viewport?: AgentViewport;
  scale?:    1 | 2;
  fullPage?: boolean;
  format?:   'jpeg' | 'png';
  quality?:  number;
}

export interface PaneCaptureOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
}

type PageCommand = (name: string, params?: Record<string, unknown>) => Promise<any>;

export interface CaptureMetadata {
  viewport:         AgentViewport;
  liveHumanView:    boolean;
  displayDpr:       number;
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
  cssVisualViewport: { pageX: number; pageY: number };
}

/** Optional page decorations run inside the same layout and lock as capture. */
export interface CaptureOverlays {
  prepare(): Promise<void>;
  remove(): Promise<void>;
}

/** Created inside the per-contents queue; only the view manager controls bounds. */
export interface CapturePlacement {
  parkedViewport?: AgentViewport;
  resized: boolean;
  displayDpr: number;
  assertCurrent(): void;
  release(): void;
}
export type BeginCapture = (once?: AgentViewport) => CapturePlacement;

export class AgentScreenshotCapture {
  private readonly tails = new WeakMap<WebContents, Promise<void>>();

  capture(wc: WebContents, begin: BeginCapture, options: CaptureOptions = {}, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    const scale = options.scale ?? 1;
    if (scale !== 1 && scale !== 2) throw new Error('scale must be 1 or 2');
    return this.serialize(wc, async() => {
      const placement = begin(options.viewport);
      try {
        return await this.withDebugger(wc, (command, deadline) =>
          this.captureOne(wc, placement, scale, options, command, deadline, overlays));
      } finally {
        placement.release();
      }
    });
  }

  /** Human IPC keeps the live surface, caller's optional clip and legacy result. */
  capturePane(wc: WebContents, authorize: () => void, options?: PaneCaptureOptions) {
    return this.serialize(wc, () => {
      authorize(); // the view may have moved while waiting for another capture
      return this.withDebugger(wc, async(command) => {
        const format = options?.format ?? 'jpeg';
        const { data } = await command('Page.captureScreenshot', {
          format, quality: options?.quality ?? 80, captureBeyondViewport: false,
          ...(options?.clip && { clip: { ...options.clip, scale: options.clip.scale ?? 1 } }),
        });
        authorize();
        return { base64: data as string, mediaType: `image/${ format }` };
      });
    });
  }

  private async serialize<T>(wc: WebContents, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(wc) ?? Promise.resolve();
    const operation = previous.then(run);
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

  private async withDebugger<T>(wc: WebContents, run: (command: PageCommand, deadline: number) => Promise<T>): Promise<T> {
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

    // If DevTools replaces our session mid-capture, never detach the successor.
    let detached = false;
    const onDetach = () => { detached = true };
    dbg.once('detach', onDetach);
    const deadline = Date.now() + 10_000;
    const command = (name: string, params?: Record<string, unknown>) => {
      if (detached || wc.isDestroyed()) throw new Error('Browser debugger disconnected');
      return this.until(dbg.sendCommand(name, params), deadline);
    };
    try {
      return await run(command, deadline);
    } finally {
      dbg.removeListener('detach', onDetach);
      if (ownsAttachment && !detached && !wc.isDestroyed() && dbg.isAttached()) dbg.detach();
    }
  }

  private async captureOne(wc: WebContents, placement: CapturePlacement, devicePixelRatio: 1 | 2,
    options: CaptureOptions, command: PageCommand, deadline: number, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    const { displayDpr, parkedViewport } = placement;
    const liveHumanView = !parkedViewport;
    let overlaysAttempted = false;
    try {
      const readViewport = (): Promise<AgentViewport> => this.until(
        wc.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })'), deadline);
      let viewport = await readViewport();
      if (parkedViewport) {
        // Native setBounds is synchronous in main, not in the guest renderer.
        // Poll one frame at a time; a timeout leaves no page-side polling loop.
        let needsFrame = placement.resized;
        while (needsFrame || viewport.width !== parkedViewport.width || viewport.height !== parkedViewport.height) {
          placement.assertCurrent();
          needsFrame = viewport.width !== parkedViewport.width || viewport.height !== parkedViewport.height;
          viewport = await this.until(wc.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })))'), deadline);
          if (Date.now() >= deadline) throw new Error('Timed out capturing browser viewport');
        }
      }
      if (!Number.isInteger(viewport.width) || viewport.width < 1 || viewport.width * devicePixelRatio > 16384 ||
          !Number.isInteger(viewport.height) || viewport.height < 1) throw new Error('Browser reported an unsupported live viewport');
      placement.assertCurrent();
      const layout: LayoutMetrics = await command('Page.getLayoutMetrics');
      placement.assertCurrent();
      // Even a grid would visibly modify the human's page.
      if (overlays && !liveHumanView) {
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
      placement.assertCurrent();
      const { data } = await command('Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? { quality: options.quality ?? 80 } : {}),
        fromSurface: true, captureBeyondViewport: true,
        // Never let a 1x1 document/iframe host determine the visible frame.
        clip: { x: fullPage ? 0 : layout.cssVisualViewport.pageX, y: fullPage ? 0 : layout.cssVisualViewport.pageY,
          width: viewport.width, height: cssHeight, scale: devicePixelRatio / displayDpr },
      });
      placement.assertCurrent();
      if (liveHumanView) {
        const now = await readViewport();
        placement.assertCurrent();
        if (now.width !== viewport.width || now.height !== viewport.height) throw new Error('Human pane resized during capture');
      }
      if (!data) throw new Error('Browser returned an empty screenshot');
      return { base64: data, mediaType: `image/${ format }`, metadata: {
        viewport, liveHumanView, displayDpr, devicePixelRatio, fullPage, capped: requested > cssHeight, cssHeight,
      } };
    } finally {
      if (overlaysAttempted) await this.until(overlays!.remove(), Date.now() + 1000);
    }
  }
}
