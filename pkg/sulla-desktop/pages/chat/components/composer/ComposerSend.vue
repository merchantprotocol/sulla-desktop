<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <button
    :class="['composer-send', { running, ready: canSend }]"
    type="button"
    :disabled="!canSend"
    :aria-label="running ? 'Queue message' : 'Send message'"
    :title="running ? 'Queue message · Enter' : 'Send message · Enter'"
    @click="activate"
  >
    <span
      class="send-arrow"
      aria-hidden="true"
    >↑</span>
    <span
      v-if="running"
      class="action-label"
    >Queue</span>
  </button>
</template>

<script setup lang="ts">
import { activateComposerSend } from './ComposerSendBehavior';

const props = defineProps<{
  running: boolean;
  canSend: boolean;
}>();
const emit = defineEmits<(e: 'send') => void>();

function activate(): void {
  activateComposerSend(props.canSend, () => emit('send'));
}
</script>

<style>
.composer-send { display: none; }

.composer-send {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin: 0 0 0 6px;
  padding: 0;
  flex: 0 0 38px;
  border: 0;
  border-radius: 50%;
  color: var(--text-dim);
  background: var(--border-subtle);
  cursor: default;
  transition: background 0.25s, color 0.25s, box-shadow 0.25s,
    transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
.composer-send.ready {
  color: var(--text-primary);
  background: linear-gradient(180deg, var(--accent-hover), var(--accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 50%, transparent), inset 0 1px 0 var(--bg-overlay);
  cursor: pointer;
  transform: scale(1.05);
}
.composer-send.ready {
  color: var(--text-on-accent);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 35%, transparent);
}
.composer-send.running {
  width: auto;
  min-width: 76px;
  flex-basis: auto;
  padding: 0 13px;
  grid-auto-flow: column;
  gap: 7px;
  border-radius: 19px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--border-default) 35%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-default);
  cursor: default;
  transform: none;
}
.composer-send.running.ready {
  color: var(--text-on-accent);
  background: linear-gradient(180deg, var(--accent-hover), var(--accent));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 35%, transparent);
  cursor: pointer;
}
.composer-send:active:not(:disabled) {
  transform: scale(0.86);
  transition-duration: 0.08s;
}
.send-arrow {
  font-size: 18px;
  font-weight: 700;
  transition: transform 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1), opacity 0.2s;
}
.action-label {
  font: 700 11px/1 var(--font-body);
  letter-spacing: 0.01em;
}

@media (prefers-reduced-motion: reduce) {
  .composer-send,
  .send-arrow { animation: none; transition: none; }
}
</style>
