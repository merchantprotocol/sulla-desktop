<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <!-- Screen preview -->
  <div v-if="currentLayout === 'sidebyside'" class="sbs-grid">
    <article v-for="channel in channels" :key="channel.id" class="sbs-tile" @contextmenu.prevent="$emit(channel.type === 'camera' ? 'show-camera-menu' : channel.type === 'screen' ? 'show-screen-menu' : 'show-audio-menu', $event, channel.id)">
      <div class="live-source-controls">
        <button type="button" class="live-source-action" :aria-label="pausedSources[channel.id] ? `Resume ${channel.name}` : `Pause ${channel.name}`" @click.stop="$emit('toggle-pause', channel.id)">{{ pausedSources[channel.id] ? '▶' : 'Ⅱ' }}</button>
        <button type="button" class="live-source-action close" :aria-label="`Remove ${channel.name}`" @click.stop="$emit('remove-source', channel.id)">×</button>
      </div>
      <video v-if="channel.stream" :ref="el => bindChannelVideo(channel.id, el as HTMLVideoElement | null)" autoplay muted playsinline />
      <div v-else-if="channel.type === 'mic' || channel.type === 'system'" class="sbs-audio-meter">
        <span v-for="(height, index) in meterBars(channel.level || 0)" :key="index" :style="{ height: `${height}px` }" />
      </div>
      <div v-else class="placeholder">{{ channel.name }}</div>
      <span class="sbs-label">{{ channel.name }}</span>
    </article>
    <div v-if="channels.length === 0" class="placeholder">Turn on a source to preview it</div>
  </div>

  <div v-show="currentLayout !== 'sidebyside'" class="screen-preview"
    @contextmenu.prevent="$emit(primarySource?.type === 'camera' ? 'show-camera-menu' : 'show-screen-menu', $event, primarySource?.id)"
  >
    <div v-if="primarySource" class="live-source-controls">
      <button type="button" class="live-source-action" :aria-label="pausedSources[primarySource.id] ? `Resume ${primarySource.name}` : `Pause ${primarySource.name}`" @click.stop="$emit('toggle-pause', primarySource.id)">{{ pausedSources[primarySource.id] ? '▶' : 'Ⅱ' }}</button>
      <button type="button" class="live-source-action close" :aria-label="`Remove ${primarySource.name}`" @click.stop="$emit('remove-source', primarySource.id)">×</button>
    </div>
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
    @contextmenu.prevent="$emit(pipSource?.type === 'screen' ? 'show-screen-menu' : 'show-camera-menu', $event, pipSource?.id)"
  >
    <div v-if="pipSource" class="live-source-controls">
      <button type="button" class="live-source-action" :aria-label="pausedSources[pipSource.id] ? `Resume ${pipSource.name}` : `Pause ${pipSource.name}`" @click.stop="$emit('toggle-pause', pipSource.id)">{{ pausedSources[pipSource.id] ? '▶' : 'Ⅱ' }}</button>
      <button type="button" class="live-source-action close" :aria-label="`Remove ${pipSource.name}`" @click.stop="$emit('remove-source', pipSource.id)">×</button>
    </div>
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
    @contextmenu.prevent="$emit(primarySource?.type === 'screen' ? 'show-screen-menu' : 'show-camera-menu', $event, primarySource?.id)"
  >
    <div v-if="primarySource" class="live-source-controls">
      <button type="button" class="live-source-action" :aria-label="pausedSources[primarySource.id] ? `Resume ${primarySource.name}` : `Pause ${primarySource.name}`" @click.stop="$emit('toggle-pause', primarySource.id)">{{ pausedSources[primarySource.id] ? '▶' : 'Ⅱ' }}</button>
      <button type="button" class="live-source-action close" :aria-label="`Remove ${primarySource.name}`" @click.stop="$emit('remove-source', primarySource.id)">×</button>
    </div>
    <video
      ref="fullCameraVideoEl"
      autoplay
      muted
      playsinline
      :style="{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px', display: screenStream ? 'block' : 'none' }"
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
    @contextmenu.prevent="$emit('show-audio-menu', $event, audioOnlySourceId)"
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
    <div class="live-source-controls-list">
      <div v-for="channel in audioChannels" :key="channel.id" class="live-source-controls">
        <button type="button" class="live-source-action" :aria-label="pausedSources[channel.id] ? `Resume ${channel.name}` : `Pause ${channel.name}`" @click.stop="$emit('toggle-pause', channel.id)">{{ pausedSources[channel.id] ? '▶' : 'Ⅱ' }}</button>
        <button type="button" class="live-source-action close" :aria-label="`Remove ${channel.name}`" @click.stop="$emit('remove-source', channel.id)">×</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';

interface Source {
  id:            string;
  type:          string;
  name:          string;
  on:            boolean;
  isVideo:       boolean;
  [key: string]: any;
}

interface Channel { id: string; type: string; name: string; stream?: MediaStream | null; level?: number }

const props = defineProps<{
  screenStream:     MediaStream | null;
  cameraStream:     MediaStream | null;
  currentLayout:    string;
  primarySource:    Source | null;
  pipSource:        Source | null;
  audioOnlySources: string;
  audioOnlySourceId: string;
  channels: Channel[];
  pausedSources: Record<string, boolean>;
}>();

const audioChannels = computed(() => props.channels.filter(channel => channel.type === 'mic' || channel.type === 'system'));

defineEmits<{
  (e: 'show-screen-menu', event: MouseEvent, sourceId?: string): void;
  (e: 'show-camera-menu', event: MouseEvent, sourceId?: string): void;
  (e: 'show-audio-menu', event: MouseEvent, sourceId?: string): void;
  (e: 'toggle-pause', sourceId: string): void;
  (e: 'remove-source', sourceId: string): void;
}>();

const screenVideoEl = ref<HTMLVideoElement | null>(null);
const sbsCameraVideoEl = ref<HTMLVideoElement | null>(null);
const fullCameraVideoEl = ref<HTMLVideoElement | null>(null);
const audioMeterVisRef = ref<HTMLElement | null>(null);
const channelVideos = new Map<string, HTMLVideoElement>();
function bindChannelVideo(id: string, element: HTMLVideoElement | null) {
  if (!element) { channelVideos.delete(id); return; }
  channelVideos.set(id, element);
  const stream = props.channels.find(channel => channel.id === id)?.stream;
  if (element.srcObject !== stream) element.srcObject = stream || null;
}
function meterBars(level: number): number[] {
  const amplitude = Math.min(1, Math.max(0, level));
  return Array.from({ length: 36 }, (_, index) => 3 + Math.round(amplitude * (8 + 16 * (1 - Math.abs(index - 18) / 18))));
}
watch(() => props.channels.map(channel => [channel.id, channel.stream]), () => nextTick(() => {
  for (const channel of props.channels) {
    const video = channelVideos.get(channel.id);
    if (video && video.srcObject !== channel.stream) video.srcObject = channel.stream || null;
  }
}), { deep: true, immediate: true });

// Bind screen stream to video element
watch(() => props.screenStream, (stream) => {
  console.log('[CaptureCanvas] screenStream watcher fired:', stream ? 'stream' : 'null', stream?.active ? 'active' : 'inactive');
  nextTick(() => {
    const el = screenVideoEl.value;
    console.log('[CaptureCanvas] screenVideoEl:', el ? 'exists' : 'null');
    if (!el) return;
    try {
      el.srcObject = stream || null;
      // Fullscreen displays the primary assignment, not the secondary/PiP slot.
      const fullEl = fullCameraVideoEl.value;
      if (fullEl) fullEl.srcObject = stream || null;
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
  });
}, { immediate: true });

defineExpose({ audioMeterVisRef });
</script>

<style>
.live-source-controls,
.live-source-controls-list {
  position: absolute;
  z-index: 5;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 120ms ease;
}
.live-source-controls-list { flex-direction: column; align-items: flex-end; }
.live-source-controls-list .live-source-controls { position: static; opacity: 1; }
.sbs-tile:hover > .live-source-controls,
.screen-preview:hover > .live-source-controls,
.sbs-camera:hover > .live-source-controls,
.fullscreen-camera:hover > .live-source-controls,
.audio-only-display:hover > .live-source-controls-list,
.live-source-controls:focus-within,
.live-source-controls-list:focus-within { opacity: 1; }
.live-source-action {
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255,255,255,.45);
  border-radius: 6px;
  color: white;
  background: rgba(18, 22, 28, .82);
  cursor: pointer;
  font: inherit;
}
.live-source-action:hover { background: rgba(50, 60, 72, .96); }
.live-source-action:focus-visible { opacity: 1; outline: 2px solid #fff; outline-offset: 2px; }
.live-source-action.close { font-size: 20px; line-height: 20px; }
.audio-only-display { position: relative; }
</style>
