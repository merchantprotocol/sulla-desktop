// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { CameraStreamService } from '../../../../pages/capture-studio/effects/CameraStreamService';
import { VideoEffectService, type FrameSurface } from '../../../../pages/capture-studio/effects/VideoEffectService';
import type { PersonInference } from '../../../../pages/capture-studio/effects/PersonInference';

/** Synchronize on the injected acquisition boundary, never an assumed microtask count. */
class DeferredAcquisition {
  private signalStarted!: () => void;
  private resolveStream!: (stream: MediaStream) => void;
  readonly started = new Promise<void>(resolve => { this.signalStarted = resolve; });
  private readonly stream = new Promise<MediaStream>(resolve => { this.resolveStream = resolve; });
  acquire(): Promise<MediaStream> { this.signalStarted(); return this.stream; }
  resolve(stream: MediaStream): void { this.resolveStream(stream); }
}
class CameraFixture {
  stopped = false;
  getVideoTracks(): any[] { return [{ stop: () => { this.stopped = true; }, addEventListener: () => undefined }]; }
  getTracks(): any[] { return this.getVideoTracks(); }
  asStream(): MediaStream { return this as unknown as MediaStream; }
}
class EffectFixture implements PersonInference {
  initialized = 0;
  async initialize(): Promise<void> { this.initialized++; }
  async infer(): Promise<never> { throw new Error('not scheduled'); }
  close(): void {}
}
class SurfaceFixture implements FrameSurface {
  readonly video = {} as HTMLVideoElement;
  readonly canvas = {} as HTMLCanvasElement;
  readonly output = new CameraFixture();
  async open(): Promise<MediaStream> { return this.output.asStream(); }
  schedule(): number { return 1; }
  cancel(): void {}
  drawRaw(): void {}
  close(): void { this.output.getTracks()[0].stop(); }
}
class CompositionFixture {
  readonly inference = new EffectFixture();
  readonly surfaces: SurfaceFixture[] = [];
  published: MediaStream | null = null;
  readonly effects = new VideoEffectService(() => this.inference, () => {
    const surface = new SurfaceFixture(); this.surfaces.push(surface); return surface;
  }, () => ({} as HTMLCanvasElement), () => undefined);
  service(acquire: () => Promise<MediaStream>): CameraStreamService {
    return new CameraStreamService(this.effects, acquire, value => { this.published = value; }, () => undefined);
  }
}

describe('CameraStreamService actual core lifecycle', () => {
  it('risk: recording-integrity — off does not initialize model; recording pins stream and rejects mutations', async() => {
    const fixture = new CompositionFixture(); const raw = new CameraFixture();
    const camera = fixture.service(async() => raw.asStream());
    expect(await camera.acquire({ video: true })).toBe(raw);
    expect(fixture.inference.initialized).toBe(0);
    expect(await camera.beginRecording()).toBe(fixture.published);
    expect(() => camera.acquire({ video: true })).toThrow('Stop recording');
    await expect(camera.release()).rejects.toThrow('Stop recording');
    expect(() => camera.setOptions({ autoFrame: true, soften: 0, backgroundBlur: 0 })).toThrow('Stop recording');
    camera.endRecording();
    await camera.setOptions({ autoFrame: true, soften: 0, backgroundBlur: 0 });
    expect(fixture.inference.initialized).toBe(1);
    expect(camera.stream).toBe(fixture.published);
    expect(camera.stream).not.toBe(raw);
    expect(raw.stopped).toBe(false);
    await camera.dispose();
    expect(raw.stopped).toBe(true);
    expect(fixture.published).toBeNull();
  });

  it('risk: device-privacy — stale acquisition after switch or unmount is stopped, never published', async() => {
    const fixture = new CompositionFixture(); const stale = new CameraFixture(); const fresh = new CameraFixture();
    const deferred = new DeferredAcquisition();
    let calls = 0;
    const camera = fixture.service(() => ++calls === 1 ? deferred.acquire() : Promise.resolve(fresh.asStream()));
    const first = camera.acquire({ video: true });
    const rejected = expect(first).rejects.toThrow('superseded');
    await deferred.started;
    await camera.acquire({ video: true });
    deferred.resolve(stale.asStream());
    await rejected;
    expect(stale.stopped).toBe(true);
    expect(camera.stream).toBe(fresh);
    await camera.release();
    expect(fresh.stopped).toBe(true);
    await camera.dispose();
    expect(() => camera.acquire({ video: true })).toThrow('disposed');
  });

  it('risk: device-privacy — dispose drains a deferred acquisition; invalid options leave current stream intact', async() => {
    const fixture = new CompositionFixture(); const raw = new CameraFixture();
    const deferred = new DeferredAcquisition();
    const camera = fixture.service(() => deferred.acquire());
    const acquisition = camera.acquire({ video: true });
    const rejected = expect(acquisition).rejects.toThrow('superseded');
    await deferred.started;
    const closed = camera.dispose();
    deferred.resolve(raw.asStream());
    await rejected; await closed;
    expect(raw.stopped).toBe(true);
    expect(fixture.published).toBeNull();
    const second = fixture.service(async() => new CameraFixture().asStream());
    await second.acquire({ video: true });
    const original = second.stream;
    await expect(second.setOptions({ autoFrame: false, soften: NaN, backgroundBlur: 0 })).rejects.toThrow('strengths');
    expect(second.stream).toBe(original);
    await second.dispose();
  });
});

it('risk: recording-integrity — deferred requested camera + options must settle before recorder stream selection', async() => {
  const fixture = new CompositionFixture(); const raw = new CameraFixture();
  const deferred = new DeferredAcquisition();
  const camera = fixture.service(() => deferred.acquire());
  const acquisition = camera.acquire({ video: true });
  await deferred.started;
  const options = camera.setOptions({ autoFrame: true, soften: 0, backgroundBlur: 0 });
  const selection = camera.beginRecording();
  deferred.resolve(raw.asStream());
  await acquisition; await options;
  const selected = await selection;
  expect(selected).toBe(fixture.published);
  expect(selected).toBeDefined();
  expect(selected).not.toBe(raw);
  expect(raw.stopped).toBe(false);
  camera.endRecording(); await camera.dispose();
});
