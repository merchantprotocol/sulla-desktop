<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <article class="playback-tile" :class="'tile-' + stream.type" @contextmenu.prevent="emit('context-menu', $event, stream.id)">
    <div class="tile-label">
      <span class="tile-dot" :style="{ background: color }" />
      <span>{{ label }}</span>
      <div class="tile-actions">
        <button type="button" :aria-label="paused ? `Play ${label}` : `Pause ${label}`" @click.stop="emit('toggle', stream.id)">{{ paused ? 'Play' : 'Pause' }}</button>
        <button type="button" class="tile-remove" :aria-label="`Close ${label}`" @click.stop="emit('close', stream.id)">×</button>
      </div>
    </div>
    <div class="tile-media">
      <video v-if="stream.isVideo" :ref="el => emit('media', stream.id, el as HTMLMediaElement | null)" :src="'file://' + stream.filePath" controls @play="emit('play', stream.id)" @pause="emit('pause', stream.id)" style="width: 100%; height: 100%; object-fit: contain; background: #000; border-radius: 6px;" />
      <div v-else class="tile-audio-wrap">
        <div class="tile-audio-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" :stroke="color" stroke-width="1.5"><path v-if="stream.type === 'mic'" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path v-if="stream.type === 'mic'" d="M19 10v2a7 7 0 0 1-14 0v-2" /><path v-if="stream.type === 'system-audio'" d="M11 5L6 9H2v6h4l5 4V5z" /><path v-if="stream.type === 'system-audio'" d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path v-if="stream.type === 'system-audio'" d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg></div>
        <audio :ref="el => emit('media', stream.id, el as HTMLMediaElement | null)" :src="'file://' + stream.filePath" controls @play="emit('play', stream.id)" @pause="emit('pause', stream.id)" style="width: 100%;" />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
interface PlaybackTileStream { id: string; type: string; filePath: string; isVideo: boolean }

defineProps<{ stream: PlaybackTileStream; label: string; color: string; paused: boolean }>();
const emit = defineEmits<{
  (event: 'media', id: string, element: HTMLMediaElement | null): void;
  (event: 'toggle' | 'close' | 'play' | 'pause', id: string): void;
  (event: 'context-menu', mouseEvent: MouseEvent, id: string): void;
}>();
</script>
