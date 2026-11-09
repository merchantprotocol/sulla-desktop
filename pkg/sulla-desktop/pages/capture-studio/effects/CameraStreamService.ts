// SPDX-License-Identifier: GPL-2.0-or-later
import type { EffectOptions } from './FrameCompositor';
import type { CameraEffectSession, VideoEffectService } from './VideoEffectService';

/** Owns raw acquisition; effects own only generated video. Audio remains on raw. */
export class CameraStreamService {
  private raw?: MediaStream;
  private session?: CameraEffectSession;
  private generation = 0;
  private pending?: Promise<MediaStream>;
  private recording = false;
  private disposed = false;
  private options: EffectOptions = { autoFrame: false, soften: 0, backgroundBlur: 0 };

  constructor(
    private readonly effects: VideoEffectService,
    private readonly acquireRaw: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
    private readonly publish: (stream: MediaStream | null) => void,
    private readonly report: (error: unknown) => void,
  ) {}

  get rawStream(): MediaStream | undefined { return this.raw; }
  get stream(): MediaStream | undefined { return this.session?.stream; }
  get effectOptions(): EffectOptions { return { ...this.options }; }

  assertMutable(): void {
    if (this.disposed) throw new Error('Camera service is disposed');
    if (this.recording) throw new Error('Stop recording before changing the camera or effects');
  }

  acquire(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.assertMutable();
    const operation = this.replace(constraints);
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined; }).catch(() => undefined);
    return operation;
  }

  private async replace(constraints: MediaStreamConstraints): Promise<MediaStream> {
    const generation = ++this.generation;
    await this.clear();
    if (generation !== this.generation || this.disposed) throw new Error('Camera acquisition superseded');
    const raw = await this.acquireRaw(constraints);
    if (generation !== this.generation || this.disposed) {
      raw.getTracks().forEach(track => track.stop());
      throw new Error('Camera acquisition superseded');
    }
    if (!raw.getVideoTracks().length) {
      raw.getTracks().forEach(track => track.stop());
      throw new Error('Camera capture returned no video tracks');
    }
    this.raw = raw;
    raw.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.raw === raw) {
        ++this.generation;
        void this.clear().catch(this.report);
      }
    }, { once: true });
    return this.process(raw, generation);
  }

  private async process(raw: MediaStream, generation: number): Promise<MediaStream> {
    const session = await this.effects.open(raw, this.options);
    if (generation !== this.generation || this.disposed) {
      await session.close();
      throw new Error('Camera processing superseded');
    }
    this.session = session;
    this.publish(session.stream);
    return session.stream;
  }

  setOptions(options: EffectOptions): Promise<void> {
    this.assertMutable();
    const operation = this.updateOptions(options);
    this.pending = operation.then(() => this.stream as MediaStream);
    const pending = this.pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return operation;
  }

  private async updateOptions(options: EffectOptions): Promise<void> {
    if (![options.soften, options.backgroundBlur].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Effect strengths must be between zero and one');
    }
    this.options = { ...options };
    // Reacquiring is unnecessary: retain raw ownership and replace only the effect session.
    const generation = ++this.generation;
    const previous = this.session;
    this.session = undefined;
    this.publish(null);
    await previous?.close();
    if (this.raw && generation === this.generation) {
      await this.process(this.raw, generation);
    }
  }

  /** Locks before any asynchronous recorder/audio startup; no mid-recording replacement. */
  async beginRecording(): Promise<MediaStream | undefined> {
    this.assertMutable();
    this.recording = true;
    try { await this.pending; return this.stream; }
    catch (error) { this.recording = false; throw error; }
  }

  endRecording(): void { this.recording = false; }

  async release(): Promise<void> {
    this.assertMutable();
    ++this.generation;
    await this.clear();
  }

  /** Teardown only after recorder.stopSession has flushed its final chunks. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.recording = false;
    ++this.generation;
    await this.clear();
    await this.pending?.catch(() => undefined);
  }

  private async clear(): Promise<void> {
    const session = this.session; const raw = this.raw;
    this.session = undefined; this.raw = undefined;
    this.publish(null);
    try { await session?.close(); }
    finally { raw?.getTracks().forEach(track => track.stop()); }
  }
}
