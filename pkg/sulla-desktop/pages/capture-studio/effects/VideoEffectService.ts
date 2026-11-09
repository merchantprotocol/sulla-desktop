// SPDX-License-Identifier: GPL-2.0-or-later
import { FrameCompositor, PersonFraming, type EffectOptions } from './FrameCompositor';
import type { PersonInference } from './PersonInference';

export interface FrameSurface {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  open(raw: MediaStream): Promise<MediaStream>;
  schedule(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
  drawRaw(): void;
  close(): void;
}

/** Video-only output. Caller owns raw video AND audio; later recorder integration must preserve audio separately. */
export class BrowserFrameSurface implements FrameSurface {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  private output?: MediaStream;

  constructor(private readonly document: Document, private readonly window: Window) {
    this.video = document.createElement('video');
    this.canvas = document.createElement('canvas');
    // Camera video is opaque. Avoid a lossy VP9 alpha plane on captureStream recordings.
    if (!this.canvas.getContext('2d', { alpha: false })) throw new Error('Canvas unavailable');
  }

  async open(raw: MediaStream): Promise<MediaStream> {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = raw;
    await this.video.play();
    if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('Camera frame is not ready');
    // Bound all processing/compositor surfaces to 720p, preserving source aspect ratio.
    const scale = Math.min(1, 1280 / this.video.videoWidth, 720 / this.video.videoHeight);
    this.canvas.width = Math.max(1, Math.floor(this.video.videoWidth * scale));
    this.canvas.height = Math.max(1, Math.floor(this.video.videoHeight * scale));
    this.drawRaw();
    this.output = this.canvas.captureStream(30);
    return this.output;
  }

  schedule(callback: (timestamp: number) => void): number {
    return this.window.requestAnimationFrame(callback);
  }

  cancel(handle: number): void { this.window.cancelAnimationFrame(handle); }

  drawRaw(): void {
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.resetTransform();
    context.filter = 'none';
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'copy';
    context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    context.globalCompositeOperation = 'source-over';
  }

  close(): void {
    this.output?.getTracks().forEach(track => track.stop());
    this.output = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

/** One session = one model, one output stream for both future preview and recorder consumers. */
export class CameraEffectSession {
  private closed = false;
  private started = false;
  private failed = false;
  private handle?: number;
  private active?: Promise<void>;
  private initializing?: Promise<void>;
  private closing?: Promise<void>;
  private released = false;
  private lastFrame = -1;
  private lastInference = -Infinity;
  private currentOutput?: MediaStream;
  private options: EffectOptions;

  constructor(
    private readonly raw: MediaStream,
    options: EffectOptions,
    private readonly inference: PersonInference,
    private readonly compositor: FrameCompositor,
    private readonly surface: FrameSurface,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.options = this.validate(options);
  }

  get stream(): MediaStream { return this.currentOutput ?? this.raw; }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Session already started or closed');
    this.started = true;
    if (!this.enabled()) return;
    this.initializing = this.initialize();
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    try {
      const output = await this.surface.open(this.raw);
      if (this.closed) return;
      await this.inference.initialize();
      if (!this.closed) {
        this.currentOutput = output;
        this.schedule();
      }
    } catch (error) {
      this.failed = true;
      this.currentOutput = undefined;
      this.notify(error);
    } finally {
      if (this.closed || this.failed) this.release();
    }
  }

  update(options: EffectOptions): void {
    const next = this.validate(options);
    if (!this.currentOutput && (next.autoFrame || next.soften > 0 || next.backgroundBlur > 0)) {
      throw new Error('Reopen disabled or failed session to enable effects');
    }
    this.options = next;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.currentOutput = undefined;
    if (this.handle !== undefined) {
      try { this.surface.cancel(this.handle); } catch (error) { this.notify(error); }
      this.handle = undefined;
    }
    this.closing = this.finishClose();
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    try {
      // Startup owns allocation until it settles; never race close against model creation.
      await this.initializing;
      await this.active;
    } finally {
      this.release();
    }
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.currentOutput = undefined;
    try { this.inference.close(); } catch (error) { this.notify(error); }
    finally {
      try { this.surface.close(); } catch (error) { this.notify(error); }
      finally {
        try { this.compositor.close(); } catch (error) { this.notify(error); }
      }
    }
  }

  private schedule(): void {
    this.handle = this.surface.schedule(timestamp => {
      this.handle = undefined;
      this.active = this.frame(timestamp);
    });
  }

  private async frame(timestamp: number): Promise<void> {
    try {
      if (this.closed) return;
      if (!this.enabled() || this.failed) {
        this.surface.drawRaw();
      } else if (this.surface.video.currentTime !== this.lastFrame && timestamp - this.lastInference >= 66) {
        this.lastFrame = this.surface.video.currentTime;
        this.lastInference = timestamp;
        const mask = await this.inference.infer(this.surface.video, timestamp);
        if (!this.closed) this.compositor.draw(this.surface.video, this.surface.canvas, mask, this.options, timestamp);
      }
    } catch (error) {
      this.failed = true;
      this.notify(error);
      // Keep the shared canvas stream alive; never swap recording tracks mid-recording.
      try { if (!this.closed) this.surface.drawRaw(); } catch { this.stopOutput(); }
    } finally {
      if (!this.closed) this.schedule();
    }
  }

  private stopOutput(): void {
    this.closed = true;
    this.release();
  }

  private enabled(): boolean { return this.options.autoFrame || this.options.soften > 0 || this.options.backgroundBlur > 0; }

  private validate(options: EffectOptions): EffectOptions {
    if (![options.soften, options.backgroundBlur].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Effect strengths must be between zero and one');
    }
    return { ...options };
  }

  private notify(error: unknown): void {
    try { this.onFailure(error); } catch { /* Consumer reporting must not break cleanup. */ }
  }
}

/** Dependency factories ensure independent lifecycle state for each caller-owned raw stream. */
export class VideoEffectService {
  constructor(
    private readonly createInference: () => PersonInference,
    private readonly createSurface: () => FrameSurface,
    private readonly createCanvas: () => HTMLCanvasElement,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  async open(raw: MediaStream, options: EffectOptions, report?: (error: unknown) => void): Promise<CameraEffectSession> {
    const session = new CameraEffectSession(
      raw, options, this.createInference(),
      new FrameCompositor(new PersonFraming(), this.createCanvas), this.createSurface(), error => { try { this.onFailure(error); } finally { report?.(error); } },
    );
    await session.start();
    return session;
  }
}
