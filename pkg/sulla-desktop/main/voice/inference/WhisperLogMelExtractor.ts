// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Computes Whisper's 80-bin log-mel frames for Smart Turn's 8-second window. */
export class WhisperLogMelExtractor {
  readonly frameCount = 800;
  readonly melBins = 80;
  private readonly cosine = new Float32Array(201 * 400);
  private readonly sine = new Float32Array(201 * 400);
  private readonly hann = new Float32Array(400);
  constructor() {
    for (let i = 0; i < 400; i++) this.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 400);
    for (let k = 0; k <= 200; k++) for (let i = 0; i < 400; i++) { const angle = 2 * Math.PI * k * i / 400; this.cosine[k * 400 + i] = Math.cos(angle); this.sine[k * 400 + i] = Math.sin(angle); }
  }
  extract(audio: Float32Array): Float32Array {
    const window = 16000 * 8; const padded = new Float32Array(window);
    padded.set(audio.subarray(Math.max(0, audio.length - window)), Math.max(0, window - audio.length));
    const mean = padded.reduce((sum, value) => sum + value, 0) / padded.length;
    const variance = padded.reduce((sum, value) => sum + (value - mean) ** 2, 0) / padded.length;
    const deviation = Math.sqrt(variance) || 1;
    for (let i = 0; i < padded.length; i++) padded[i] = (padded[i] - mean) / deviation;
    const output = new Float32Array(this.frameCount * this.melBins);
    // Match pipecat-ai/smart-turn/inference.py at a347da2bbb569a64b09c8d4d9c14faf1ee04bd14:
    // WhisperFeatureExtractor(chunk_length=8, do_normalize=True), 80-bin features.
    for (let frame = 0; frame < this.frameCount; frame++) {
      const start = frame * 160 - 200; const power = new Float64Array(201);
      for (let k = 0; k <= 200; k++) {
        let real = 0; let imaginary = 0;
        for (let i = 0; i < 400; i++) {
          let sample = start + i;
          if (sample < 0) sample = -sample;
          else if (sample >= window) sample = 2 * window - sample - 2;
          const value = padded[sample] * this.hann[i]; const basis = k * 400 + i;
          real += value * this.cosine[basis]; imaginary -= value * this.sine[basis];
        }
        power[k] = real ** 2 + imaginary ** 2;
      }
      for (let bin = 0; bin < this.melBins; bin++) {
        const lower = this.melToHz(this.melBin(bin)); const center = this.melToHz(this.melBin(bin + 1)); const upper = this.melToHz(this.melBin(bin + 2)); let sum = 0;
        for (let k = 0; k < power.length; k++) { const hz = k * 16000 / 400; const weight = hz < lower || hz > upper ? 0 : hz <= center ? (hz - lower) / (center - lower) : (upper - hz) / (upper - center); sum += power[k] * weight / (upper - lower); }
        output[frame * this.melBins + bin] = Math.log10(Math.max(sum, 1e-10));
      }
    }
    const max = Math.max(...output);
    for (let i = 0; i < output.length; i++) output[i] = (Math.max(output[i], max - 8) + 4) / 4;
    return output;
  }
  private melBin(bin: number): number { const max = this.hzToMel(8000); return bin * max / (this.melBins + 1); }
  private hzToMel(hz: number): number { return hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27); }
  private melToHz(mel: number): number { return mel < 15 ? mel * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15)); }
}
