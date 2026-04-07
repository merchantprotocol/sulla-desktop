/**
 * @module audio-driver/controller/AudioNoiseProcessor
 *
 * # AudioNoiseProcessor — 4-Layer Noise Reduction Pipeline
 *
 * Processes raw PCM (s16le, 16kHz, mono) through four layers to produce
 * clean voice audio. Used by MicrophoneDriverController for all gated
 * (speech-only) audio paths.
 *
 * ## Layers
 *
 * 1. **High-pass filter (80 Hz)** — removes low-frequency rumble (fan
 *    vibration, AC hum, desk bumps). Human speech starts ~85 Hz.
 *
 * 2. **RNNoise (neural net)** — Mozilla's WASM-based noise suppression.
 *    Trained on thousands of noise/speech samples. Removes broadband
 *    noise, keyboard clicks, traffic, etc.
 *
 * 3. **Noise profile subtraction** — estimates ambient noise spectrum
 *    during silence, subtracts it from speech frames. Removes steady-state
 *    noise that RNNoise may not fully eliminate.
 *
 * 4. **Soft crossfade envelope** — smooths transitions at speech boundaries.
 *    Fades in over ~20ms, fades out over ~50ms. Eliminates click artifacts.
 *
 * ## Usage
 *
 * ```ts
 * const processor = new AudioNoiseProcessor();
 * await processor.init();
 * const clean = processor.process(rawPcmChunk, isSpeaking);
 * processor.dispose();
 * ```
 */

import { log } from '../model/logger';

// ── Layer 1: High-pass filter ───────────────────────────────────

/**
 * Simple 2nd-order Butterworth high-pass at ~80 Hz.
 * Coefficients computed for 16kHz sample rate.
 *
 * Transfer function: H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
 */
const HP_CUTOFF = 80;
const HP_Q = 0.7071; // Butterworth Q

const DEFAULT_SAMPLE_RATE = 48000;

function computeHighPassCoeffs(fc: number, fs: number, Q: number) {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);

  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
  };
}

// ── Layer 3: Noise profile ──────────────────────────────────────

const FFT_SIZE = 256;
const NOISE_PROFILE_FRAMES = 20; // ~300ms of silence to build profile
const SPECTRAL_FLOOR = 0.001;    // minimum magnitude after subtraction

// ── Layer 4: Crossfade ──────────────────────────────────────────

// ── RNNoise constants ───────────────────────────────────────────

const RNNOISE_FRAME_SIZE = 480; // 10ms at 48kHz

export class AudioNoiseProcessor {
  private static readonly TAG = 'AudioNoiseProcessor';

  private _sampleRate: number;
  private _fadeInSamples: number;
  private _fadeOutSamples: number;

  // ── Layer 1: High-pass state ──────────────────────────────────
  private _hp: ReturnType<typeof computeHighPassCoeffs>;
  private _hpX1 = 0; private _hpX2 = 0;
  private _hpY1 = 0; private _hpY2 = 0;

  // ── Layer 2: RNNoise state ────────────────────────────────────
  private _rnnoiseModule: any = null;
  private _rnnoiseState: number = 0; // pointer
  private _rnnoiseFramePtr: number = 0; // WASM heap pointer for frame data
  private _rnnoiseReady = false;
  private _rnnoisePendingBuffer: Float32Array = new Float32Array(0);

  // ── Layer 3: Noise profile state ──────────────────────────────
  private _noiseProfile: Float64Array = new Float64Array(FFT_SIZE / 2);
  private _noiseFrameCount = 0;
  private _noiseProfileReady = false;

  // ── Layer 4: Crossfade state ──────────────────────────────────
  private _envelope = 0; // 0 = silence, 1 = full volume
  private _wasSpeaking = false;

  // ── Init ──────────────────────────────────────────────────────

  constructor(sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this._sampleRate = sampleRate;
    this._fadeInSamples = Math.round(sampleRate * 0.050);   // 50ms
    this._fadeOutSamples = Math.round(sampleRate * 0.150);  // 150ms
    this._hp = computeHighPassCoeffs(HP_CUTOFF, sampleRate, HP_Q);
  }

  async init(): Promise<void> {
    try {
      // Dynamic import for ESM WASM module
      const { default: RNNoise } = await import('@echogarden/rnnoise-wasm');
      this._rnnoiseModule = await RNNoise();

      // Create RNNoise denoiser state
      this._rnnoiseState = this._rnnoiseModule._rnnoise_create(0);
      const frameSize = this._rnnoiseModule._rnnoise_get_frame_size();
      log.info(AudioNoiseProcessor.TAG, 'RNNoise initialized', { frameSize, statePtr: this._rnnoiseState });

      // Allocate frame buffer on WASM heap (float32, 480 samples)
      this._rnnoiseFramePtr = this._rnnoiseModule._malloc(frameSize * 4);
      this._rnnoiseReady = true;
    } catch (e: any) {
      log.warn(AudioNoiseProcessor.TAG, 'RNNoise init failed — layer 2 disabled', { error: e.message });
      this._rnnoiseReady = false;
    }
  }

  // ── Main processing ───────────────────────────────────────────

  /**
   * Process a PCM chunk through all 4 layers.
   *
   * @param chunk - Raw s16le 16kHz mono PCM buffer
   * @param speaking - Whether VAD currently detects speech
   * @returns Processed PCM buffer (same format, same length)
   */
  process(chunk: Buffer, speaking: boolean): Buffer {
    const samples = chunk.length / 2;
    const output = Buffer.alloc(chunk.length);

    // Convert s16le to float64 for processing
    const floats = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      floats[i] = chunk.readInt16LE(i * 2) / 32768;
    }

    // Layer 1: High-pass filter
    this._applyHighPass(floats);

    // Layer 2: RNNoise — neural noise suppression
    // Audio is now native 48kHz, matching RNNoise's expected frame size (480 samples = 10ms)
    if (this._rnnoiseReady) {
      this._applyRNNoise(floats);
    }

    // Layer 3: Noise profile subtraction — DISABLED
    // Needs proper overlap-add windowing (Hann window + 50% overlap) to
    // avoid click artifacts at chunk boundaries. RNNoise handles broadband
    // noise removal; this layer can be re-enabled once overlap-add is implemented.
    // For now, just keep building the noise profile for future use.
    if (!speaking) {
      this._updateNoiseProfile(floats);
    }

    // Layer 4: Soft crossfade envelope
    this._applyCrossfade(floats, speaking);

    // Convert back to s16le
    for (let i = 0; i < samples; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      output.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
    }

    return output;
  }

  // ── Dispose ───────────────────────────────────────────────────

  dispose(): void {
    if (this._rnnoiseReady && this._rnnoiseModule) {
      try {
        if (this._rnnoiseFramePtr) this._rnnoiseModule._free(this._rnnoiseFramePtr);
        if (this._rnnoiseState) this._rnnoiseModule._rnnoise_destroy(this._rnnoiseState);
      } catch { /* ignore */ }
      this._rnnoiseReady = false;
    }
    log.info(AudioNoiseProcessor.TAG, 'Disposed');
  }

  // ── Layer 1: High-pass filter ─────────────────────────────────

  private _applyHighPass(samples: Float64Array): void {
    const { b0, b1, b2, a1, a2 } = this._hp;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = b0 * x + b1 * this._hpX1 + b2 * this._hpX2
                - a1 * this._hpY1 - a2 * this._hpY2;
      this._hpX2 = this._hpX1; this._hpX1 = x;
      this._hpY2 = this._hpY1; this._hpY1 = y;
      samples[i] = y;
    }
  }

  // ── Layer 2: RNNoise ──────────────────────────────────────────

  private _applyRNNoise(samples: Float64Array): void {
    if (!this._rnnoiseReady) return;

    // Prepend leftover samples from previous chunk
    const combined = new Float32Array(this._rnnoisePendingBuffer.length + samples.length);
    combined.set(this._rnnoisePendingBuffer);
    for (let i = 0; i < samples.length; i++) {
      combined[this._rnnoisePendingBuffer.length + i] = samples[i];
    }

    // Process in 480-sample frames (10ms at 48kHz — native RNNoise frame size)
    let pos = 0;
    let outputPos = 0;

    while (pos + RNNOISE_FRAME_SIZE <= combined.length) {
      const heapF32 = this._rnnoiseModule.HEAPF32 as Float32Array;
      const heapOffset = this._rnnoiseFramePtr / 4;

      // Copy frame to WASM heap (scaled to int16 range for RNNoise)
      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        heapF32[heapOffset + i] = combined[pos + i] * 32768;
      }

      // Process in place
      this._rnnoiseModule._rnnoise_process_frame(
        this._rnnoiseState,
        this._rnnoiseFramePtr,
        this._rnnoiseFramePtr,
      );

      // Read back into combined buffer
      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        combined[pos + i] = heapF32[heapOffset + i] / 32768;
      }

      pos += RNNOISE_FRAME_SIZE;
    }

    // Copy processed samples back to output (skip the pending prefix)
    const pendingLen = this._rnnoisePendingBuffer.length;
    const processedForOutput = Math.min(samples.length, pos - pendingLen);
    for (let i = 0; i < processedForOutput; i++) {
      samples[i] = combined[pendingLen + i];
    }

    // Save remaining unprocessed samples for next chunk
    this._rnnoisePendingBuffer = combined.slice(pos);
  }

  // ── Layer 3: Noise profile ────────────────────────────────────

  private _updateNoiseProfile(samples: Float64Array): void {
    // Simple power spectrum estimation from time-domain samples
    // (using overlapping windows without full FFT for efficiency)
    const binCount = FFT_SIZE / 2;
    const frameLen = Math.min(samples.length, FFT_SIZE);

    // Compute magnitude spectrum approximation
    const spectrum = new Float64Array(binCount);
    for (let k = 0; k < binCount; k++) {
      let re = 0, im = 0;
      const freq = k / FFT_SIZE;
      for (let n = 0; n < frameLen; n++) {
        const angle = 2 * Math.PI * freq * n;
        re += samples[n] * Math.cos(angle);
        im -= samples[n] * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(re * re + im * im) / frameLen;
    }

    // Running average of noise profile
    if (this._noiseFrameCount < NOISE_PROFILE_FRAMES) {
      const alpha = 1 / (this._noiseFrameCount + 1);
      for (let k = 0; k < binCount; k++) {
        this._noiseProfile[k] = this._noiseProfile[k] * (1 - alpha) + spectrum[k] * alpha;
      }
      this._noiseFrameCount++;
      if (this._noiseFrameCount >= NOISE_PROFILE_FRAMES) {
        this._noiseProfileReady = true;
        log.info(AudioNoiseProcessor.TAG, 'Noise profile ready');
      }
    } else {
      // Slow adaptation during ongoing silence
      const alpha = 0.05;
      for (let k = 0; k < binCount; k++) {
        this._noiseProfile[k] = this._noiseProfile[k] * (1 - alpha) + spectrum[k] * alpha;
      }
    }
  }

  private _subtractNoiseProfile(samples: Float64Array): void {
    const binCount = FFT_SIZE / 2;
    const frameLen = Math.min(samples.length, FFT_SIZE);

    // Forward DFT
    const re = new Float64Array(binCount);
    const im = new Float64Array(binCount);
    for (let k = 0; k < binCount; k++) {
      const freq = k / FFT_SIZE;
      for (let n = 0; n < frameLen; n++) {
        const angle = 2 * Math.PI * freq * n;
        re[k] += samples[n] * Math.cos(angle);
        im[k] -= samples[n] * Math.sin(angle);
      }
    }

    // Subtract noise magnitude, preserve phase
    for (let k = 0; k < binCount; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const phase = Math.atan2(im[k], re[k]);
      const cleanMag = Math.max(SPECTRAL_FLOOR * frameLen, mag - this._noiseProfile[k] * frameLen * 1.5);
      re[k] = cleanMag * Math.cos(phase);
      im[k] = cleanMag * Math.sin(phase);
    }

    // Inverse DFT (simplified, real signal)
    for (let n = 0; n < frameLen; n++) {
      let val = 0;
      for (let k = 0; k < binCount; k++) {
        const freq = k / FFT_SIZE;
        const angle = 2 * Math.PI * freq * n;
        val += re[k] * Math.cos(angle) - im[k] * Math.sin(angle);
      }
      samples[n] = val * 2 / FFT_SIZE;
    }
  }

  // ── Layer 4: Soft crossfade ───────────────────────────────────

  private _applyCrossfade(samples: Float64Array, speaking: boolean): void {
    if (speaking && !this._wasSpeaking) {
      // Fade in
      for (let i = 0; i < samples.length; i++) {
        this._envelope = Math.min(1, this._envelope + 1 / this._fadeInSamples);
        samples[i] *= this._envelope;
      }
    } else if (!speaking && this._wasSpeaking) {
      // Fade out
      for (let i = 0; i < samples.length; i++) {
        this._envelope = Math.max(0, this._envelope - 1 / this._fadeOutSamples);
        samples[i] *= this._envelope;
      }
    } else if (!speaking) {
      // Silence
      this._envelope = 0;
      samples.fill(0);
    } else {
      // Sustained speech
      this._envelope = 1;
    }

    this._wasSpeaking = speaking;
  }
}
