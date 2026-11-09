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

/** Owns only the detached video and canvas output; the caller always owns input tracks. */
export class BrowserFrameSurface implements FrameSurface {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  private output?: MediaStream;

  constructor(private readonly document: Document, private readonly window: Window) {
    this.video = document.createElement('video');
    this.canvas = document.createElement('canvas');
  }

  async open(raw: MediaStream): Promise<MediaStream> {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = raw;
    await this.video.play();
    if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('Camera frame is not ready');
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
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
    try {
      this.currentOutput = await this.surface.open(this.raw);
      await this.inference.initialize();
      if (!this.closed) this.schedule();
    } catch (error) {
      this.failed = true;
      this.currentOutput = undefined;
      this.surface.close();
      this.inference.close();
      this.notify(error);
    }
  }

  update(options: EffectOptions): void {
    const next = this.validate(options);
    if (!this.currentOutput && (next.autoFrame || next.soften > 0 || next.backgroundBlur > 0)) {
      throw new Error('Reopen disabled or failed session to enable effects');
    }
    this.options = next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handle !== undefined) this.surface.cancel(this.handle);
    // Never close a model while an outstanding inference still owns its buffers.
    await this.active;
    this.inference.close();
    this.surface.close();
    this.currentOutput = undefined;
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
    this.inference.close();
    this.surface.close();
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

  async open(raw: MediaStream, options: EffectOptions): Promise<CameraEffectSession> {
    const session = new CameraEffectSession(
      raw, options, this.createInference(),
      new FrameCompositor(new PersonFraming(), this.createCanvas), this.createSurface(), this.onFailure,
    );
    await session.start();
    return session;
  }
}
