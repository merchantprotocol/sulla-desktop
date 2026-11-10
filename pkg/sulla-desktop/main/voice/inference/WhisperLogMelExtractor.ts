// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Computes Whisper's 80-bin log-mel frames for Smart Turn's 8-second window. */
export class WhisperLogMelExtractor {
  readonly frameCount = 800;
  readonly melBins = 80;
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
      const real = new Float64Array(512); const imaginary = new Float64Array(512); const start = frame * 160;
      for (let i = 0; i < 400; i++) real[i] = padded[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 399));
      this.fft(real, imaginary);
      const power = Array.from({ length: 257 }, (_, k) => (real[k] ** 2 + imaginary[k] ** 2) / 512);
      for (let bin = 0; bin < this.melBins; bin++) {
        const lower = this.melToHz(this.melBinsToMel(bin)); const center = this.melToHz(this.melBinsToMel(bin + 1)); const upper = this.melToHz(this.melBinsToMel(bin + 2)); let sum = 0;
        for (let k = 0; k < power.length; k++) { const hz = k * 16000 / 512; const weight = hz < lower || hz > upper ? 0 : hz <= center ? (hz - lower) / (center - lower) : (upper - hz) / (upper - center); sum += power[k] * weight; }
        output[frame * this.melBins + bin] = Math.log10(Math.max(sum, 1e-10));
      }
    }
    const max = Math.max(...output);
    for (let i = 0; i < output.length; i++) output[i] = (Math.max(output[i], max - 8) + 4) / 4;
    return output;
  }
  private melBinsToMel(bin: number): number { return bin * this.hzToMel(8000) / (this.melBins + 1); }
  private hzToMel(hz: number): number { return 2595 * Math.log10(1 + hz / 700); }
  private melToHz(mel: number): number { return 700 * (10 ** (mel / 2595) - 1); }
  private fft(real: Float64Array, imaginary: Float64Array): void {
    for (let i = 1, j = 0; i < 512; i++) { let bit = 256; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; } }
    for (let size = 2; size <= 512; size *= 2) { const angle = -2 * Math.PI / size; for (let start = 0; start < 512; start += size) for (let j = 0; j < size / 2; j++) { const c = Math.cos(angle * j); const s = Math.sin(angle * j); const even = start + j; const odd = even + size / 2; const tr = c * real[odd] - s * imaginary[odd]; const ti = s * real[odd] + c * imaginary[odd]; real[odd] = real[even] - tr; imaginary[odd] = imaginary[even] - ti; real[even] += tr; imaginary[even] += ti; } }
  }
}
