// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Minimal complex value used by the exact mixed-radix real FFT. */
interface ComplexValue {
  real: number;
  imaginary: number;
}

/** Computes Whisper's 80-bin log-mel frames for Smart Turn's 8-second window. */
export class WhisperLogMelExtractor {
  readonly frameCount = 800;
  readonly melBins = 80;
  private readonly hann = new Float64Array(400);

  constructor() {
    for (let index = 0; index < this.hann.length; index++) {
      this.hann[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / 400);
    }
  }

  extract(audio: Float32Array): Float32Array {
    const sampleCount = 16_000 * 8;
    const padded = new Float64Array(sampleCount);
    const copied = audio.subarray(Math.max(0, audio.length - sampleCount));
    padded.set(copied, sampleCount - copied.length);

    const mean = padded.reduce((sum, value) => sum + value, 0) / padded.length;
    const variance = padded.reduce((sum, value) => sum + (value - mean) ** 2, 0) / padded.length;
    const deviation = Math.sqrt(variance) || 1;
    for (let index = 0; index < padded.length; index++) {
      padded[index] = (padded[index] - mean) / deviation;
    }

    const output = new Float32Array(this.melBins * this.frameCount);
    // Match pipecat-ai/smart-turn/inference.py at a347da2bbb569a64b09c8d4d9c14faf1ee04bd14
    // and transformers v4.44.2 audio_utils.spectrogram (power=2, center=True,
    // reflect padding) and WhisperFeatureExtractor._np_extract_fbank_features:
    // https://github.com/huggingface/transformers/blob/v4.44.2/src/transformers/audio_utils.py
    // It drops the final STFT frame, uses log10(clamp(x, 1e-10)), clamps at max-8,
    // then applies (x+4)/4. Feature matrix order is [mel, frame].
    for (let frame = 0; frame < this.frameCount; frame++) {
      const start = frame * 160 - 200;
      const spectrum = this.powerSpectrum(padded, start);
      for (let bin = 0; bin < this.melBins; bin++) {
        const lower = this.melToHz(this.melPoint(bin));
        const center = this.melToHz(this.melPoint(bin + 1));
        const upper = this.melToHz(this.melPoint(bin + 2));
        let sum = 0;
        for (let frequencyBin = 0; frequencyBin < spectrum.length; frequencyBin++) {
          const hz = (frequencyBin * 16_000) / 400;
          if (hz < lower || hz > upper) continue;
          const triangle =
            hz <= center ? (hz - lower) / (center - lower) : (upper - hz) / (upper - center);
          // Slaney area normalization from transformers mel_filter_bank(norm="slaney").
          sum += spectrum[frequencyBin] * triangle * (2 / (upper - lower));
        }
        output[bin * this.frameCount + frame] = Math.log10(Math.max(sum, 1e-10));
      }
    }

    let maximum = -Infinity;
    for (const value of output) maximum = Math.max(maximum, value);
    for (let index = 0; index < output.length; index++) {
      output[index] = (Math.max(output[index], maximum - 8) + 4) / 4;
    }
    return output;
  }

  /** Exposed for a regression test against the direct DFT's model-input values. */
  powerSpectrumForFrame(frame: Float32Array): Float64Array {
    if (frame.length !== this.hann.length) throw new Error('Whisper FFT frames must contain 400 samples');
    const windowed = Float64Array.from(frame, (sample, index) => sample * this.hann[index]);
    const transformed = this.fft(windowed);
    return Float64Array.from(transformed.slice(0, 201), value => value.real ** 2 + value.imaginary ** 2);
  }

  private powerSpectrum(audio: Float64Array, start: number, reflect = true): Float64Array {
    const frame = new Float64Array(400);
    for (let index = 0; index < frame.length; index++) {
      let sampleIndex = start + index;
      if (reflect) {
        if (sampleIndex < 0) sampleIndex = -sampleIndex;
        else if (sampleIndex >= audio.length) sampleIndex = 2 * audio.length - sampleIndex - 2;
      }
      frame[index] = (reflect ? audio[sampleIndex] : audio[index]) * this.hann[index];
    }
    const transformed = this.fft(frame);
    const power = new Float64Array(201);
    for (let index = 0; index < power.length; index++) {
      const value = transformed[index];
      power[index] = value.real ** 2 + value.imaginary ** 2;
    }
    return power;
  }

  /** Cooley-Tukey decomposition 400=16*25; prime factors use a small direct DFT. */
  private fft(input: Float64Array): ComplexValue[] {
    const length = input.length;
    if (length === 1) return [{ real: input[0], imaginary: 0 }];
    let factor = 2;
    while (length % factor !== 0) factor++;
    const subLength = length / factor;
    const subTransforms: ComplexValue[][] = [];
    for (let residue = 0; residue < factor; residue++) {
      const subInput = new Float64Array(subLength);
      for (let index = 0; index < subLength; index++) subInput[index] = input[residue + factor * index];
      subTransforms.push(this.fft(subInput));
    }
    const output = new Array<ComplexValue>(length);
    for (let frequency = 0; frequency < length; frequency++) {
      let real = 0;
      let imaginary = 0;
      for (let residue = 0; residue < factor; residue++) {
        const value = subTransforms[residue][frequency % subLength];
        const angle = (-2 * Math.PI * residue * frequency) / length;
        real += value.real * Math.cos(angle) - value.imaginary * Math.sin(angle);
        imaginary += value.real * Math.sin(angle) + value.imaginary * Math.cos(angle);
      }
      output[frequency] = { real, imaginary };
    }
    return output;
  }

  private melPoint(bin: number): number {
    return (bin * this.hzToMel(8_000)) / (this.melBins + 1);
  }

  private hzToMel(hz: number): number {
    return hz < 1_000 ? hz / (200 / 3) : 15 + Math.log(hz / 1_000) / (Math.log(6.4) / 27);
  }

  private melToHz(mel: number): number {
    return mel < 15 ? mel * (200 / 3) : 1_000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
  }
}
