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
  viewportSettled?: boolean;
  observedViewport?: AgentViewport | null;
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

class CaptureDeadlineExceeded extends Error {}

export class AgentScreenshotCapture {
  private readonly tails = new WeakMap<WebContents, Promise<void>>();

  capture(wc: WebContents, begin: BeginCapture, options: CaptureOptions = {}, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    const scale = options.scale ?? 1;
    if (scale !== 1 && scale !== 2) throw new Error('scale must be 1 or 2');
    return this.serialize(wc, async() => {
      const placement = begin(options.viewport);
      try {
        const screenshot = await this.withDebugger(wc, (command, deadline) =>
          this.captureOne(wc, placement, scale, options, command, deadline, overlays));
        // Cleanup can yield (e.g. removing the grid). Don't return a parked
        // result if focus won during that final part of the transaction.
        placement.assertCurrent();
        return screenshot;
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
          timer = setTimeout(() => reject(new CaptureDeadlineExceeded('Timed out capturing browser viewport')), Math.max(0, deadline - Date.now()));
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
    const deadline = Date.now() + AgentScreenshotCapture.captureBudgetMs;
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

  private static readonly captureBudgetMs = 10_000;
  private static readonly settleBudgetMs = 3_000;

  private async observeParkedViewport(wc: WebContents, placement: CapturePlacement, target: AgentViewport, deadline: number) {
    let observed: AgentViewport | null = null;
    let needsPaint = placement.resized;
    while (Date.now() < deadline) {
      placement.assertCurrent();
      const script: string = observed === null ? '({ width: innerWidth, height: innerHeight })' :
        'new Promise(resolve => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })))';
      try {
        observed = await this.until<AgentViewport>(wc.executeJavaScript(script), deadline);
      } catch (error) {
        if (!(error instanceof CaptureDeadlineExceeded)) throw error;
        break; // No renderer response (or no rAF); leave no guest-side polling loop.
      }
      const matches = observed.width === target.width && observed.height === target.height;
      if (matches && !needsPaint) return { settled: true, observed };
      needsPaint = !matches; // Wait one paint after a changed layout reaches the target.
    }
    return { settled: false, observed };
  }

  private async captureOne(wc: WebContents, placement: CapturePlacement, devicePixelRatio: 1 | 2,
    options: CaptureOptions, command: PageCommand, deadline: number, overlays?: CaptureOverlays): Promise<CapturedScreenshot> {
    const { displayDpr, parkedViewport } = placement;
    const liveHumanView = !parkedViewport;
    const readViewport = (): Promise<AgentViewport> => this.until(
      wc.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })'), deadline);
    const readiness = parkedViewport ? await this.observeParkedViewport(wc, placement, parkedViewport,
      deadline - AgentScreenshotCapture.captureBudgetMs + AgentScreenshotCapture.settleBudgetMs) : undefined;
    const fallback = readiness?.settled === false;
    const viewport = parkedViewport ?? await readViewport();
    let overlaysAttempted = false;
    try {
      if (!Number.isInteger(viewport.width) || viewport.width < 1 || viewport.width * devicePixelRatio > 16384 ||
          !Number.isInteger(viewport.height) || viewport.height < 1) throw new Error('Browser reported an unsupported live viewport');
      placement.assertCurrent();
      const layout: LayoutMetrics = await command('Page.getLayoutMetrics');
      placement.assertCurrent();
      // Even a grid would visibly modify the human's page.
      if (overlays && !liveHumanView && !fallback) {
        overlaysAttempted = true;
        await this.until(overlays.prepare(), deadline);
      }
      // Without a settled layout, document height and element positions aren't reliable.
      const fullPage = options.fullPage === true && !fallback;
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
        fromSurface: true, captureBeyondViewport: liveHumanView || fullPage || fallback,
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
        ...(readiness && { viewportSettled: readiness.settled }),
        ...(fallback && { observedViewport: readiness!.observed }),
        viewport, liveHumanView, displayDpr, devicePixelRatio, fullPage, capped: requested > cssHeight, cssHeight,
      } };
    } catch (error) {
      placement.assertCurrent(); // A lost lease isn't a layout failure.
      if (fallback) {
        const observed = readiness!.observed;
        const reported = observed ? `${ observed.width }x${ observed.height }` : 'no size';
        throw new Error(`Agent viewport did not settle: expected ${ viewport.width }x${ viewport.height }, page reports ${ reported }`);
      }
      throw error;
    } finally {
      if (overlaysAttempted) await this.until(overlays!.remove(), Date.now() + 1000);
    }
  }
}
