<template>
  <div class="track-panel" :class="{ open: tracksOpen }">
    <div class="track-panel-header">
      Tracks
      <div class="spacer"></div>
      <span class="disk-info">Disk: {{ diskDisplay }}</span>
    </div>
    <div class="track-lanes">
      <div v-for="src in sources" :key="src.id" class="track-lane">
        <div class="track-color" :class="colorMap[src.type] || 'custom'"></div>
        <div class="track-icon" :style="{ color: src.on ? 'var(--text-muted)' : 'var(--text-dim)' }">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="iconMap[src.type] || iconMap.mic"></svg>
        </div>
        <span class="track-name" :style="{ opacity: src.on ? 1 : 0.4 }">{{ src.name }}</span>
        <div class="track-wave">
          <div class="bars">
            <div
              v-for="j in 100"
              :key="j"
              class="b"
              :style="{
                background: waveColor(src.type),
                height: getTrackBarHeight(src, j - 1) + 'px',
              }"
            ></div>
          </div>
          <div v-if="recording" class="playhead"></div>
        </div>
        <span class="track-status">{{ src.on ? src.status : 'off' }}</span>
        <button
          class="track-mute"
          :class="{ muted: !src.on }"
          @click="$emit('toggle-src', src)"
        >M</button>
        <button
          v-if="!src.builtin"
          class="track-remove"
          @click="$emit('remove-source', src.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Source {
  id: string;
  type: string;
  name: string;
  color: string;
  status: string;
  builtin: boolean;
  on: boolean;
  isVideo: boolean;
}

const props = defineProps<{
  sources: Source[];
  tracksOpen: boolean;
  recording: boolean;
  waveformData: Record<string, number[]>;
  colorMap: Record<string, string>;
  iconMap: Record<string, string>;
  diskDisplay: string;
}>();

const waveColorMap: Record<string, string> = {
  screen: '#58a6ff',
  camera: '#5096b3',
  mic: '#3fb950',
  system: '#e3b341',
};

function waveColor(type: string) {
  return waveColorMap[type] || '#b392f0';
}

function getTrackBarHeight(src: Source, barIndex: number): number {
  const data = props.waveformData[src.id];
  if (data && data.length > barIndex) return data[barIndex];
  return 2;
}

defineEmits<{
  (e: 'toggle-src', src: Source): void;
  (e: 'remove-source', id: string): void;
}>();
</script>
