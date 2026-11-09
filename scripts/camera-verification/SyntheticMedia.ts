// SPDX-License-Identifier: GPL-2.0-or-later
/** Installed before importing the real parent. Never delegates to a hardware API. */
export class SyntheticMedia {
  readonly calls: MediaStreamConstraints[] = [];
  readonly streams: MediaStream[] = [];
  private readonly canvases: HTMLCanvasElement[] = [];
  private readonly context = new AudioContext();
  private readonly oscillator = this.context.createOscillator();
  private readonly destination = this.context.createMediaStreamDestination();
  private frame = 0;
  private timer = 0;

  constructor(private readonly document: Document, private readonly media: MediaDevices) {}

  install(): void {
    this.oscillator.frequency.value = 220;
    this.oscillator.connect(this.destination);
    this.oscillator.start();
    Object.defineProperty(this.media, 'getUserMedia', { value: async(constraints: MediaStreamConstraints) => {
      this.calls.push(constraints);
      if (constraints.audio && !constraints.video) return this.destination.stream.clone();
      const canvas = this.document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      this.canvases.push(canvas);
      this.draw(canvas);
      const stream = canvas.captureStream(30);
      this.streams.push(stream);
      return stream;
    } });
    Object.defineProperty(this.media, 'enumerateDevices', { value: async() => [
      { deviceId: 'synthetic-camera', kind: 'videoinput', label: 'Synthetic camera', groupId: 'fixture' },
      { deviceId: 'synthetic-mic', kind: 'audioinput', label: 'Synthetic microphone', groupId: 'fixture' },
      { deviceId: 'synthetic-output', kind: 'audiooutput', label: 'Synthetic speaker', groupId: 'fixture' },
    ] });
    this.timer = window.setInterval(() => { this.frame++; this.canvases.forEach(canvas => this.draw(canvas)); }, 33);
  }

  private draw(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    for (let x = 0; x < 640; x += 8) {
      ctx.fillStyle = x % 16 ? '#fff' : '#000'; ctx.fillRect(x, 0, 8, 360);
    }
    ctx.fillStyle = '#ff2040'; ctx.fillRect(360, 60, 140, 240);
    ctx.fillStyle = '#20ff40'; ctx.fillRect(390, 90, 50, 50);
    // Time-varying corner proves presented frames, not a static screenshot.
    ctx.fillStyle = this.frame % 2 ? '#0010ff' : '#ffff00'; ctx.fillRect(0, 0, 24, 24);
  }

  async assertReleased(): Promise<void> {
    const deadline = performance.now() + 20000;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))) return resolve();
        if (performance.now() > deadline) return reject(new Error('Actual parent cleanup leaked raw video tracks'));
        requestAnimationFrame(check);
      };
      check();
    });
  }

  close(): void {
    clearInterval(this.timer);
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    this.destination.stream.getTracks().forEach(track => track.stop());
    this.oscillator.stop(); void this.context.close();
  }
}
