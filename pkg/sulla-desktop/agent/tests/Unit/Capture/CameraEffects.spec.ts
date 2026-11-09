// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { FrameCompositor, PersonFraming, PersonMaskRasterizer } from '../../../../pages/capture-studio/effects/FrameCompositor';
import type { PersonInference, PersonMask } from '../../../../pages/capture-studio/effects/PersonInference';
import { CameraEffectSession, type FrameSurface } from '../../../../pages/capture-studio/effects/VideoEffectService';

// Synthetic platform/inference boundaries only; never acquires media or loads a production model.
class TrackFixture {
  readyState = 'live';
  stop(): void { this.readyState = 'ended'; }
}
class StreamFixture {
  readonly track = new TrackFixture();
  getTracks(): TrackFixture[] { return [this.track]; }
  asStream(): MediaStream { return this as unknown as MediaStream; }
}
class SurfaceFixture implements FrameSurface {
  readonly video = { currentTime: 1 } as HTMLVideoElement;
  readonly canvas = {} as HTMLCanvasElement;
  readonly output = new StreamFixture();
  private callback?: (timestamp: number) => void;
  rawFrames = 0;
  open(): Promise<MediaStream> { return Promise.resolve(this.output.asStream()); }
  schedule(callback: (timestamp: number) => void): number { this.callback = callback; return 1; }
  cancel(): void { this.callback = undefined; }
  drawRaw(): void { this.rawFrames++; }
  close(): void { this.output.track.stop(); this.callback = undefined; }
  tick(timestamp: number): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.(timestamp);
  }
}
class InferenceFixture implements PersonInference {
  calls = 0;
  closed = false;
  failInit = false;
  rejectFrame?: (error: Error) => void;
  async initialize(): Promise<void> { if (this.failInit) throw new Error('Local assets unavailable'); }
  infer(): Promise<PersonMask> {
    this.calls++;
    return new Promise((_resolve, reject) => { this.rejectFrame = reject; });
  }
  close(): void { this.closed = true; }
}
class SessionFixture {
  readonly raw = new StreamFixture();
  readonly surface = new SurfaceFixture();
  readonly inference = new InferenceFixture();
  readonly errors: unknown[] = [];
  readonly session: CameraEffectSession;
  constructor(enabled = true) {
    this.session = new CameraEffectSession(
      this.raw.asStream(), { autoFrame: enabled, soften: 0, backgroundBlur: 0 },
      this.inference, new FrameCompositor(new PersonFraming(), () => ({} as HTMLCanvasElement)),
      this.surface, error => this.errors.push(error),
    );
  }
}

describe('camera processing ownership and person-follow', () => {
  // risk: data-integrity — appearance processing must not soften hair, clothes or the background.
  it('isolates face skin for softening while keeping all person categories sharp over background blur', () => {
    const mask = { width: 6, height: 1, categories: new Uint8Array([0, 1, 2, 3, 4, 5]) };
    const rasterizer = new PersonMaskRasterizer();
    const skin = rasterizer.alpha(mask, true);
    const person = rasterizer.alpha(mask, false);
    expect([0, 1, 2, 3, 4, 5].map(index => skin[index * 4 + 3])).toEqual([0, 0, 0, 255, 0, 0]);
    expect([0, 1, 2, 3, 4, 5].map(index => person[index * 4 + 3])).toEqual([0, 255, 255, 255, 255, 255]);
    expect(() => rasterizer.alpha({ ...mask, width: 7 }, true)).toThrow('Invalid person mask');
  });

  // risk: core-business-rules — a smaller second person must not steal framing.
  it('follows the largest silhouette, clamps crop and returns smoothly toward center on loss', () => {
    const tracker = new PersonFraming();
    const mask: PersonMask = {
      width: 10, height: 2,
      categories: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1]),
    };
    const right = tracker.crop(mask, 1000, 500, 0, true);
    expect(right.x).toBe(200);
    expect(right.width).toBe(800);
    const lost = tracker.crop(undefined, 1000, 500, 250, true);
    expect(lost.x).toBeLessThanOrEqual(right.x);
    expect(lost.x).toBeGreaterThan(100);
    const off = tracker.crop(mask, 1000, 500, 500, false);
    expect(off).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  // risk: data-integrity — stopping processing must never stop caller-owned camera tracks.
  it('passes through when disabled and leaves raw tracks live after disposal', async() => {
    const fixture = new SessionFixture(false);
    await fixture.session.start();
    expect(fixture.session.stream).toBe(fixture.raw);
    expect(fixture.inference.calls).toBe(0);
    await fixture.session.close();
    expect(fixture.raw.track.readyState).toBe('live');
  });

  // risk: data-integrity — failed model initialization cannot leak a canvas track.
  it('cleans up generated output and returns raw when local initialization fails', async() => {
    const fixture = new SessionFixture();
    fixture.inference.failInit = true;
    await fixture.session.start();
    expect(fixture.session.stream).toBe(fixture.raw);
    expect(fixture.surface.output.track.readyState).toBe('ended');
    expect(fixture.raw.track.readyState).toBe('live');
    expect(fixture.inference.closed).toBe(true);
    expect(fixture.errors).toHaveLength(1);
  });

  // risk: data-integrity — dispose during inference cannot close buffers still in use or queue work.
  it('allows one inference in flight and waits for it before cleanup', async() => {
    const fixture = new SessionFixture();
    await fixture.session.start();
    fixture.surface.tick(100);
    fixture.surface.tick(200);
    expect(fixture.inference.calls).toBe(1);
    const closing = fixture.session.close();
    expect(fixture.inference.closed).toBe(false);
    fixture.inference.rejectFrame!(new Error('Stopped inference'));
    await closing;
    expect(fixture.inference.closed).toBe(true);
    expect(fixture.surface.output.track.readyState).toBe('ended');
    expect(fixture.raw.track.readyState).toBe('live');
    fixture.surface.tick(300);
    expect(fixture.inference.calls).toBe(1);
  });

  // risk: data-integrity — a recorder must not lose its shared track after model failure.
  it('keeps the same output stream and resumes raw frames after inference failure', async() => {
    const fixture = new SessionFixture();
    await fixture.session.start();
    const output = fixture.session.stream;
    fixture.surface.tick(100);
    fixture.inference.rejectFrame!(new Error('Inference failed'));
    // Deterministic promise checkpoint; no timers or hardware.
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.session.stream).toBe(output);
    expect(fixture.surface.output.track.readyState).toBe('live');
    expect(fixture.surface.rawFrames).toBe(1);
    fixture.surface.tick(200);
    expect(fixture.surface.rawFrames).toBe(2);
    expect(fixture.inference.calls).toBe(1);
    await fixture.session.close();
  });
});
