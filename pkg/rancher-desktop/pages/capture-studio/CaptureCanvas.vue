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
  <div class="sbs-camera" @contextmenu.prevent="$emit('show-camera-menu', $event)">
    <video
      v-if="cameraStream"
      ref="sbsCameraVideoEl"
      autoplay
      muted
      style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px;"
    ></video>
    <div v-else class="placeholder">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      {{ pipSource?.name || 'Camera' }}
    </div>
  </div>

  <!-- Full-screen camera (shown in camonly layout) -->
  <div class="fullscreen-camera" @contextmenu.prevent="$emit('show-camera-menu', $event)">
    <video
      v-if="cameraStream"
      ref="fullCameraVideoEl"
      autoplay
      muted
      style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px;"
    ></video>
    <div v-else class="placeholder">
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
  (e: 'show-camera-menu', event: MouseEvent): void;
}>();

const screenVideoEl = ref<HTMLVideoElement | null>(null);
const sbsCameraVideoEl = ref<HTMLVideoElement | null>(null);
const fullCameraVideoEl = ref<HTMLVideoElement | null>(null);
const audioMeterVisRef = ref<HTMLElement | null>(null);

// Bind screen stream to video element
watch(() => props.screenStream, (stream) => {
  const el = screenVideoEl.value;
  if (el) {
    try {
      el.srcObject = stream && stream.active ? stream : null;
    } catch (e: any) {
      console.warn('[CaptureCanvas] Failed to set screen srcObject:', e.message);
      el.srcObject = null;
    }
  }
});

// Bind camera stream to all camera video elements
watch(() => props.cameraStream, (stream) => {
  const safeStream = stream && stream.active ? stream : null;
  const sbsEl = sbsCameraVideoEl.value;
  if (sbsEl) {
    try {
      sbsEl.srcObject = safeStream;
    } catch (e: any) {
      console.warn('[CaptureCanvas] Failed to set sbs camera srcObject:', e.message);
      sbsEl.srcObject = null;
    }
  }
  const fullEl = fullCameraVideoEl.value;
  if (fullEl) {
    try {
      fullEl.srcObject = safeStream;
    } catch (e: any) {
      console.warn('[CaptureCanvas] Failed to set full camera srcObject:', e.message);
      fullEl.srcObject = null;
    }
  }
});

defineExpose({ audioMeterVisRef });
</script>
