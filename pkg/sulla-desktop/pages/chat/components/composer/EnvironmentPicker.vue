<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div ref="container" class="environment-picker" @keydown.esc.stop="close(true)">
    <button ref="toggle" type="button" class="environment-pill" aria-label="Environment" :aria-expanded="open"
      @click="open = !open" @mousedown.stop>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path :d="selected ? remoteIcon : localIcon" /></svg>
      <span>{{ selected?.name ?? 'This device' }}</span><span aria-hidden="true">⌄</span>
    </button>
    <div v-if="open" class="environment-menu" @mousedown.stop>
      <strong>Environment</strong>
      <button type="button" :aria-pressed="!selected" @click="choose(undefined)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path :d="localIcon" /></svg>This device
        <small>{{ !selected ? '✓　' : '' }}Online</small>
      </button>
      <button v-for="device in devices" :key="device.id" type="button" :disabled="!device.online"
        :aria-pressed="device.id === selected?.id" @click="choose(device)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path :d="remoteIcon" /></svg>{{ device.name }}
        <small>{{ selected?.id === device.id ? '✓　' : '' }}{{ device.online ? 'Online' : 'Offline · Last seen' }}</small>
      </button>
      <p>{{ bound ? 'Choosing another device opens a new chat. This thread stays here.' : 'Choose where this draft will run when you send it.' }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { RemoteDevice } from '../../services/RemoteChatSession';

type Choice = RemoteDevice & { online: boolean };
defineProps<{ selected?: RemoteDevice; devices: Choice[]; bound: boolean }>();
const emit = defineEmits<{ choose: [device?: RemoteDevice] }>();
const open = ref(false);
const container = ref<HTMLElement>();
const toggle = ref<HTMLButtonElement>();
const remoteIcon = 'M2 2.5h12v9H2zM8 12v2M5 14h6';
const localIcon = 'M3 3h10v8H3zM1 13h14';

function close(focus = false): void {
  if (!open.value) return;
  open.value = false;
  if (focus) toggle.value?.focus();
}
function choose(device?: RemoteDevice): void {
  close();
  emit('choose', device);
}
function outside(event: MouseEvent): void {
  if (event.target instanceof Node && !container.value?.contains(event.target)) close();
}
onMounted(() => document.addEventListener('click', outside));
onUnmounted(() => document.removeEventListener('click', outside));
</script>

<style scoped>
.environment-picker { position: relative; flex: 0 0 auto; }
.environment-pill, .environment-menu button { display: flex; align-items: center; gap: 7px; font: 500 12.5px var(--font-body); color: var(--text-secondary); cursor: pointer; }
.environment-pill { height: 30px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: 15px; background: var(--bg-surface); }
.environment-pill span:first-of-type { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-picker svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-linejoin: round; }
.environment-menu { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 31; width: 255px; padding: 8px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); box-shadow: var(--elev-float); color: var(--text-primary); }
.environment-menu strong, .environment-menu p { display: block; margin: 6px; font-size: 12px; }
.environment-menu p, .environment-menu small { color: var(--text-muted); }
.environment-menu button { width: 100%; min-height: 34px; text-align: left; background: transparent; border: 0; border-radius: 6px; padding: 6px; }
.environment-menu button:not(:disabled):hover, .environment-menu button[aria-pressed=true] { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.environment-menu small { margin-left: auto; white-space: nowrap; }
.environment-menu button:disabled { opacity: .55; cursor: not-allowed; }
</style>
