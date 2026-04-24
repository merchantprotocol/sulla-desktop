<!--
  Shown in place of the textarea while mic is live.

  Waveform visibility + motion is driven by the real VAD signal from
  AudioDriverClient (surfaced via controller.voice.speaking + .level).
  When the user isn't actually talking, the bars fade out rather than
  animating on a canned CSS keyframe — so the meter reads the room
  honestly and stops looking like it's pretending.
-->
<template>
  <div class="voice-ui">
    <span class="label">{{ speaking ? 'Hearing you' : 'Listening' }}</span>
    <span class="timer">{{ timerLabel }}</span>
    <span
      class="waveform"
      :class="{ active: speaking }"
      aria-hidden="true"
    >
      <span
        v-for="(bar, i) in bars"
        :key="i"
        :style="{ height: bar + '%' }"
      />
    </span>
    <button class="stop-rec" type="button" @click="$emit('stop')">Stop · ⏎</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue';

const props = defineProps<{
  startedAt: number;
  /** 0..1 mic RMS from AudioDriverClient. */
  level?:    number;
  /** VAD classification — true only when user is actually speaking. */
  speaking?: boolean;
}>();
defineEmits<{ (e: 'stop'): void }>();

const now = ref(Date.now());
let t: ReturnType<typeof setInterval> | null = null;
onMounted(() => { t = setInterval(() => { now.value = Date.now(); }, 200); });
onBeforeUnmount(() => { if (t) clearInterval(t); });

const timerLabel = computed(() => {
  const s = Math.max(0, Math.floor((now.value - props.startedAt) / 1000));
  return `${ Math.floor(s / 60) }:${ String(s % 60).padStart(2, '0') }`;
});

// 16 bars with a bell-shaped envelope — the middle bars swing most,
// the edges stay calm. This produces the familiar voice-meter pulse
// without depending on a per-bar FFT (AudioDriverClient gives us a
// scalar RMS, not a frequency split).
const BAR_COUNT = 16;
const ENVELOPE = Array.from({ length: BAR_COUNT }, (_, i) => {
  const centered = Math.abs((i + 0.5) - BAR_COUNT / 2) / (BAR_COUNT / 2); // 0 center → 1 edges
  return 1 - centered * 0.55;
});

// Slight jitter so adjacent bars don't lock-step. Re-roll only when
// the VAD flag toggles to keep the pattern coherent between samples.
const jitter = ref<number[]>(Array.from({ length: BAR_COUNT }, () => 0.85 + Math.random() * 0.3));
watch(() => props.speaking, () => {
  jitter.value = Array.from({ length: BAR_COUNT }, () => 0.85 + Math.random() * 0.3);
});

const bars = computed(() => {
  const active = props.speaking === true;
  const level = Math.max(0, Math.min(1, props.level ?? 0));
  // Idle floor reads as a quiet horizon line; active scales with level.
  const floor = active ? 14 : 6;
  const span = active ? 72 : 0;
  return ENVELOPE.map((envelope, i) => {
    const raw = floor + level * span * envelope * jitter.value[i];
    return Math.max(4, Math.min(100, raw));
  });
});

const speaking = computed(() => props.speaking === true);
</script>

<style scoped>
.voice-ui {
  flex: 1; display: flex; align-items: center; gap: 16px;
  font-family: var(--mono);
}
.label {
  font-size: 10px; letter-spacing: 0.28em; text-transform: uppercase;
  color: var(--steel-400); font-weight: 700;
  display: inline-flex; align-items: center; gap: 9px; flex-shrink: 0;
}
.label::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400);
  animation: chat-pulse 1.2s infinite;
}
.timer {
  font-variant-numeric: tabular-nums; color: var(--read-1);
  font-size: 13px; font-weight: 500; flex-shrink: 0;
}
.waveform {
  flex: 1; display: flex; align-items: center; gap: 3px; height: 24px; justify-content: center;
  transition: opacity 180ms ease;
  opacity: 0.35;
}
.waveform.active { opacity: 1; }
.waveform span {
  display: block; width: 2.5px; border-radius: 1.5px;
  background: var(--steel-400);
  box-shadow: 0 0 4px rgba(106, 176, 204, 0.2);
  transition: height 80ms linear, box-shadow 180ms ease;
}
.waveform.active span {
  box-shadow: 0 0 6px rgba(106, 176, 204, 0.45);
}

.stop-rec {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--steel-100);
  padding: 6px 12px; border-radius: 100px;
  background: transparent; border: 1px solid var(--steel-400);
  cursor: pointer; flex-shrink: 0; transition: all 0.15s ease;
}
.stop-rec:hover {
  background: var(--steel-500); color: white;
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.35);
}
</style>
