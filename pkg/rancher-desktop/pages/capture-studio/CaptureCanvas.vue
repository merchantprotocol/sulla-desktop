<template>
  <!-- Screen preview -->
  <div
    class="screen-preview"
    @contextmenu.prevent="$emit('show-screen-menu', $event)"
  >
    <video
      ref="screenVideoEl"
      autoplay
      muted
      playsinline
      :style="{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: '12px', display: screenStream ? 'block' : 'none' }"
    />
    <div
      v-if="!screenStream"
      class="placeholder"
    >
      <svg
        width="56"
        height="56"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
      ><rect
        x="2"
        y="3"
        width="20"
        height="14"
        rx="2"
      /><line
        x1="8"
        y1="21"
        x2="16"
        y2="21"
      /><line
        x1="12"
        y1="17"
        x2="12"
        y2="21"
      /></svg>
      {{ primarySource?.name || 'Screen Capture' }}
    </div>
  </div>

  <!-- Side-by-side camera (shown in sidebyside layout) -->
  <div
    class="sbs-camera"
    @contextmenu.prevent="$emit('show-camera-menu', $event)"
  >
    <video
      ref="sbsCameraVideoEl"
      autoplay
      muted
      playsinline
      :style="{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px', display: cameraStream ? 'block' : 'none' }"
    />
    <div
      v-if="!cameraStream"
      class="placeholder"
    >
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
      ><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle
        cx="12"
        cy="7"
        r="4"
      /></svg>
      {{ pipSource?.name || 'Camera' }}
    </div>
  </div>

  <!-- Full-screen camera (shown in camonly layout) -->
  <div
    class="fullscreen-camera"
    @contextmenu.prevent="$emit('show-camera-menu', $event)"
  >
    <video
      ref="fullCameraVideoEl"
      autoplay
      muted
      playsinline
      :style="{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px', display: cameraStream ? 'block' : 'none' }"
    />
    <div
      v-if="!cameraStream"
      class="placeholder"
    >
      <svg
        width="56"
        height="56"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
      ><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle
        cx="12"
        cy="7"
        r="4"
      /></svg>
      {{ primarySource?.name || 'Camera Full' }}
    </div>
  </div>

  <!-- Audio-only display -->
  <div
    class="audio-only-display"
    :class="{ visible: currentLayout === 'audioonly' }"
    @contextmenu.prevent="$emit('show-audio-menu', $event)"
  >
    <div
      ref="audioMeterVisRef"
      class="audio-meter-vis"
    />
    <div class="audio-meter-label">
      <div class="source-name">
        {{ audioOnlySources }}
      </div>
      <div>Audio only — no video sources active</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

interface Source {
  id:            string;
  type:          string;
  name:          string;
  on:            boolean;
  isVideo:       boolean;
  [key: string]: any;
}

const props = defineProps<{
  screenStream:     MediaStream | null;
  cameraStream:     MediaStream | null;
  currentLayout:    string;
  primarySource:    Source | null;
  pipSource:        Source | null;
  audioOnlySources: string;
}>();

defineEmits<{
  (e: 'show-screen-menu', event: MouseEvent): void;
  (e: 'show-camera-menu', event: MouseEvent): void;
  (e: 'show-audio-menu', event: MouseEvent): void;
}>();

const screenVideoEl = ref<HTMLVideoElement | null>(null);
const sbsCameraVideoEl = ref<HTMLVideoElement | null>(null);
const fullCameraVideoEl = ref<HTMLVideoElement | null>(null);
const audioMeterVisRef = ref<HTMLElement | null>(null);

// Bind screen stream to video element
watch(() => props.screenStream, (stream) => {
  console.log('[CaptureCanvas] screenStream watcher fired:', stream ? 'stream' : 'null', stream?.active ? 'active' : 'inactive');
  nextTick(() => {
    const el = screenVideoEl.value;
    console.log('[CaptureCanvas] screenVideoEl:', el ? 'exists' : 'null');
    if (!el) return;
    try {
      el.srcObject = stream || null;
      console.log('[CaptureCanvas] srcObject set successfully, active:', stream?.active, 'videoTracks:', stream?.getVideoTracks().length);
    } catch (e: any) {
      console.warn('[CaptureCanvas] Failed to set screen srcObject:', e.message);
      el.srcObject = null;
    }
  });
}, { immediate: true });

// Bind camera stream to all camera video elements
watch(() => props.cameraStream, (stream) => {
  console.log('[CaptureCanvas] cameraStream watcher fired:', stream ? 'stream' : 'null');
  nextTick(() => {
    const sbsEl = sbsCameraVideoEl.value;
    if (sbsEl) {
      try { sbsEl.srcObject = stream || null } catch (e: any) {
        console.warn('[CaptureCanvas] Failed to set sbs camera srcObject:', e.message);
      }
    }

    const fullEl = fullCameraVideoEl.value;
    if (fullEl) {
      try { fullEl.srcObject = stream || null } catch (e: any) {
        console.warn('[CaptureCanvas] Failed to set full camera srcObject:', e.message);
      }
    }
  });
}, { immediate: true });

defineExpose({ audioMeterVisRef });
</script>
