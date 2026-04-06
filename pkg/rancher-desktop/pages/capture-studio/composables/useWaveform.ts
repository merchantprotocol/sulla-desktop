/**
 * Composable — real-time waveform data for track panel visualization.
 *
 * For sources with an AnalyserNode (mic): reads frequency data directly.
 * For sources with only an RMS level (speaker): generates simulated bars.
 *
 * Reference: main/trayPanel/renderer/view/meters.js
 */

import { ref, onUnmounted, type Ref } from 'vue';

const BAR_COUNT = 100;

/**
 * Create a waveform driven by an AnalyserNode (mic/camera audio).
 * Returns a reactive array of bar heights (0-18px range).
 */
export function useAnalyserWaveform(analyser: Ref<AnalyserNode | null>) {
  const bars = ref<number[]>(new Array(BAR_COUNT).fill(2));
  let animId: number | null = null;

  function poll() {
    const node = analyser.value;
    if (node) {
      const data = new Uint8Array(node.frequencyBinCount);
      node.getByteFrequencyData(data);

      // Downsample frequency bins to BAR_COUNT bars
      const binSize = Math.floor(data.length / BAR_COUNT);
      const newBars: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = 0; j < binSize; j++) {
          sum += data[i * binSize + j];
        }
        const avg = sum / binSize / 255; // 0-1
        newBars.push(Math.max(2, avg * 18));
      }
      bars.value = newBars;
    } else {
      bars.value = new Array(BAR_COUNT).fill(2);
    }
    animId = requestAnimationFrame(poll);
  }

  function start() {
    if (animId) return;
    poll();
  }

  function stop() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    bars.value = new Array(BAR_COUNT).fill(2);
  }

  onUnmounted(stop);

  return { bars, start, stop };
}

/**
 * Create a waveform driven by an RMS level ref (speaker).
 * Simulates frequency-like bars from a single RMS value.
 */
export function useRmsWaveform(level: Ref<number>) {
  const bars = ref<number[]>(new Array(BAR_COUNT).fill(2));
  let animId: number | null = null;

  function poll() {
    const rms = level.value;
    if (rms > 0.001) {
      const newBars: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        // Create a natural-looking distribution: louder in the center
        const center = BAR_COUNT / 2;
        const dist = Math.abs(i - center) / center;
        const base = (1 - dist) * rms * 16;
        const jitter = (Math.random() - 0.5) * rms * 6;
        newBars.push(Math.max(2, base + jitter));
      }
      bars.value = newBars;
    } else {
      bars.value = new Array(BAR_COUNT).fill(2);
    }
    animId = requestAnimationFrame(poll);
  }

  function start() {
    if (animId) return;
    poll();
  }

  function stop() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    bars.value = new Array(BAR_COUNT).fill(2);
  }

  onUnmounted(stop);

  return { bars, start, stop };
}

/**
 * Convert RMS level (0-1) to percentage for meter bars.
 * Uses square root for perceptual scaling.
 */
export function levelToPercent(level: number): number {
  return Math.min(100, Math.pow(level, 0.5) * 100);
}

/**
 * Convert RMS level (0-1) to dB string.
 */
export function levelToDb(level: number): string {
  if (level <= 0.0001) return '-∞';
  return (20 * Math.log10(level)).toFixed(0) + ' dB';
}
