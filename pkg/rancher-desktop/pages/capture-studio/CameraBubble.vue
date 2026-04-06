<template>
  <div
    class="cam-container"
    ref="camContainer"
    v-show="currentLayout === 'pip' && pipSource"
    @mousedown="startDrag"
  >
    <div
      class="cam-bubble"
      :class="{ recording: recording, hidden: cameraShape === 'hidden' }"
      :style="{ borderRadius: bubbleRadius }"
      @dblclick="$emit('swap')"
      @contextmenu.prevent="$emit('show-camera-menu', $event)"
    >
      <video
        v-if="cameraStream"
        ref="camVideoEl"
        autoplay
        muted
        style="width: 100%; height: 100%; object-fit: cover;"
      ></video>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    </div>
    <div class="shape-picker">
      <button
        v-for="shape in shapes"
        :key="shape.id"
        class="shape-btn"
        :class="{ active: cameraShape === shape.id }"
        @click.stop="$emit('update:cameraShape', shape.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="shape.icon"></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  cameraStream: MediaStream | null;
  recording: boolean;
  cameraShape: string;
  currentLayout: string;
  pipSource: any;
}>();

defineEmits<{
  (e: 'update:cameraShape', shape: string): void;
  (e: 'swap'): void;
  (e: 'show-camera-menu', event: MouseEvent): void;
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

// Video element ref
const camVideoEl = ref<HTMLVideoElement | null>(null);

watch(() => props.cameraStream, (stream) => {
  if (camVideoEl.value) {
    camVideoEl.value.srcObject = stream || null;
  }
});

// Drag logic
const camContainer = ref<HTMLElement | null>(null);
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOrigX = 0;
let dragOrigY = 0;

function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.shape-btn')) return;
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
