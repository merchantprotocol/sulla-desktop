<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    v-show="currentLayout === 'pip' && pipSource"
    ref="camContainer"
    class="cam-container"
    @mousedown="startDrag"
  >
    <div
      class="cam-bubble"
      :class="{ recording, hidden: cameraShape === 'hidden' }"
      :style="{ borderRadius: bubbleRadius }"
      @dblclick="$emit('swap')"
      @contextmenu.prevent="$emit(pipSource?.type === 'screen' ? 'show-screen-menu' : 'show-camera-menu', $event, pipSource?.id)"
    >
      <div class="live-source-controls">
        <button type="button" class="live-source-action" :aria-label="pausedSources[pipSource.id] ? `Resume ${pipSource.name || 'source'}` : `Pause ${pipSource.name || 'source'}`" @click.stop="$emit('toggle-pause', pipSource.id)">{{ pausedSources[pipSource.id] ? '▶' : 'Ⅱ' }}</button>
        <button type="button" class="live-source-action close" :aria-label="`Remove ${pipSource.name || 'source'}`" @click.stop="$emit('remove-source', pipSource.id)">×</button>
      </div>
      <video
        ref="camVideoEl"
        autoplay
        muted
        playsinline
        :style="{ width: '100%', height: '100%', objectFit: 'cover', display: cameraStream ? 'block' : 'none' }"
      />
      <svg
        v-if="!cameraStream"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      ><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle
        cx="12"
        cy="7"
        r="4"
      /></svg>
    </div>
    <div class="shape-picker">
      <button
        v-for="shape in shapes"
        :key="shape.id"
        class="shape-btn"
        :class="{ active: cameraShape === shape.id }"
        @click.stop="$emit('update:cameraShape', shape.id)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          v-html="shape.icon"
        />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';

const props = defineProps<{
  cameraStream:  MediaStream | null;
  recording:     boolean;
  cameraShape:   string;
  currentLayout: string;
  pipSource:     any;
  pausedSources: Record<string, boolean>;
}>();

defineEmits<{
  (e: 'update:cameraShape', shape: string): void;
  (e: 'swap'): void;
  (e: 'show-camera-menu', event: MouseEvent, sourceId?: string): void;
  (e: 'show-screen-menu', event: MouseEvent, sourceId?: string): void;
  (e: 'toggle-pause', sourceId: string): void;
  (e: 'remove-source', sourceId: string): void;
}>();

const shapes = [
  { id: 'circle', icon: '<circle cx="12" cy="12" r="10"/>' },
  { id: 'rect', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/>' },
  { id: 'rounded', icon: '<rect x="3" y="3" width="18" height="18" rx="6"/>' },
  { id: 'hidden', icon: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' },
];

const bubbleRadius = computed(() => {
  if (props.cameraShape === 'circle') return '50%';
  if (props.cameraShape === 'rect') return '8px';
  if (props.cameraShape === 'rounded') return '24px';
  return '50%';
});

// Video element — always in DOM (display:none when no stream), so ref is always available
const camVideoEl = ref<HTMLVideoElement | null>(null);

watch(() => props.cameraStream, (stream) => {
  console.log('[CameraBubble] cameraStream watcher fired:', stream ? 'stream' : 'null');
  nextTick(() => {
    const el = camVideoEl.value;
    if (!el) { console.log('[CameraBubble] video el is null'); return }
    try {
      el.srcObject = stream || null;
      console.log('[CameraBubble] srcObject set');
    } catch (e: any) {
      console.warn('[CameraBubble] Failed to set srcObject:', e.message);
      el.srcObject = null;
    }
  });
}, { immediate: true });

// Drag logic
const camContainer = ref<HTMLElement | null>(null);
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOrigX = 0;
let dragOrigY = 0;

function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.shape-btn, .live-source-action')) return;
  const el = camContainer.value;
  if (!el) return;
  dragging = true;
  el.classList.add('dragging');
  const rect = el.getBoundingClientRect();
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOrigX = rect.left;
  dragOrigY = rect.top;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = dragOrigX + 'px';
  el.style.top = dragOrigY + 'px';
  e.preventDefault();
}

function onMouseMove(e: MouseEvent) {
  if (!dragging) return;
  const el = camContainer.value;
  if (!el) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  el.style.left = (dragOrigX + dx) + 'px';
  el.style.top = (dragOrigY + dy) + 'px';
}

function onMouseUp() {
  if (!dragging) return;
  dragging = false;
  camContainer.value?.classList.remove('dragging');
}

onMounted(() => {
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});
</script>

<style>
.cam-bubble { position: relative; }
.cam-bubble .live-source-controls {
  position: absolute;
  z-index: 5;
  top: 5px;
  right: 5px;
  display: flex;
  gap: 3px;
  opacity: 0;
  transition: opacity 120ms ease;
}
.cam-bubble:hover .live-source-controls,
.cam-bubble .live-source-controls:focus-within { opacity: 1; }
.cam-bubble .live-source-action {
  width: 25px;
  height: 25px;
  border: 1px solid rgba(255,255,255,.55);
  border-radius: 6px;
  color: white;
  background: rgba(18, 22, 28, .86);
  cursor: pointer;
}
.cam-bubble .live-source-action:focus-visible { outline: 2px solid white; outline-offset: 2px; }
</style>
