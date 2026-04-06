<template>
  <!-- Screen preview -->
  <div class="screen-preview" @contextmenu.prevent="$emit('show-screen-menu', $event)">
    <video
      v-if="screenStream"
      ref="screenVideoEl"
      autoplay
      muted
      style="width: 100%; height: 100%; object-fit: contain; border-radius: 12px;"
    ></video>
    <div v-else class="placeholder">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      {{ primarySource?.name || 'Screen Capture' }}
    </div>
  </div>

  <!-- Side-by-side camera (shown in sidebyside layout) -->
  <div class="sbs-camera">
    <div class="placeholder">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      {{ pipSource?.name || 'Camera' }}
    </div>
  </div>

  <!-- Full-screen camera (shown in camonly layout) -->
  <div class="fullscreen-camera">
    <div class="placeholder">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      {{ primarySource?.name || 'Camera Full' }}
    </div>
  </div>

  <!-- Audio-only display -->
  <div
    class="audio-only-display"
    :class="{ visible: currentLayout === 'audioonly' }"
  >
    <div class="audio-meter-vis" ref="audioMeterVisRef"></div>
    <div class="audio-meter-label">
      <div class="source-name">{{ audioOnlySources }}</div>
      <div>Audio only — no video sources active</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

interface Source {
  id: string;
  type: string;
  name: string;
  on: boolean;
  isVideo: boolean;
  [key: string]: any;
}

const props = defineProps<{
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  currentLayout: string;
  primarySource: Source | null;
  pipSource: Source | null;
  audioOnlySources: string;
}>();

defineEmits<{
  (e: 'show-screen-menu', event: MouseEvent): void;
}>();

const screenVideoEl = ref<HTMLVideoElement | null>(null);
const audioMeterVisRef = ref<HTMLElement | null>(null);

// Bind screen stream to video element
watch(() => props.screenStream, (stream) => {
  if (screenVideoEl.value) {
    screenVideoEl.value.srcObject = stream || null;
  }
});

// Expose the audio meter vis ref so the parent can drive the animation
defineExpose({ audioMeterVisRef });
</script>
