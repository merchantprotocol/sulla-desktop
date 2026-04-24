<!-- Shown in place of the textarea when recording. 16-bar waveform. -->
<template>
  <div class="voice-ui">
    <span class="label">Listening</span>
    <span class="timer">{{ timerLabel }}</span>
    <span class="waveform" aria-hidden="true">
      <span v-for="i in 16" :key="i" />
    </span>
    <button class="stop-rec" type="button" @click="$emit('stop')">Stop · ⏎</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount, onMounted } from 'vue';

const props = defineProps<{ startedAt: number }>();
defineEmits<{ (e: 'stop'): void }>();

const now = ref(Date.now());
let t: ReturnType<typeof setInterval> | null = null;
onMounted(() => { t = setInterval(() => { now.value = Date.now(); }, 200); });
onBeforeUnmount(() => { if (t) clearInterval(t); });

const timerLabel = computed(() => {
  const s = Math.max(0, Math.floor((now.value - props.startedAt) / 1000));
  return `${ Math.floor(s / 60) }:${ String(s % 60).padStart(2, '0') }`;
});
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
}
.waveform span {
  display: block; width: 2.5px; border-radius: 1.5px;
  background: var(--steel-400);
  box-shadow: 0 0 4px rgba(106, 176, 204, 0.35);
  animation: wv 0.9s ease-in-out infinite;
}
.waveform span:nth-child(odd)  { animation-duration: 0.7s; }
.waveform span:nth-child(even) { animation-duration: 0.85s; }
.waveform span:nth-child(3n)   { animation-delay: 0.12s; }
.waveform span:nth-child(5n)   { animation-delay: 0.22s; }
.waveform span:nth-child(7n)   { animation-delay: 0.04s; }
@keyframes wv { 0%,100% { height: 18%; } 50% { height: 95%; } }

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
