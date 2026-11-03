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
    :disabled="!running && !canSend"
    :aria-label="running ? 'Stop Sulla' : 'Send message'"
    :title="running ? 'Stop · ESC' : 'Send · Enter'"
    @click="activate"
  >
    <span
      class="send-arrow"
      aria-hidden="true"
    >↑</span>
    <span
      class="stop-square"
      aria-hidden="true"
    />
    <span
      class="run-ring"
      aria-hidden="true"
    />
  </button>
</template>

<script setup lang="ts">
import { activateComposerSend } from './ComposerSendBehavior';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{
  running: boolean;
  canSend: boolean;
}>();
const emit = defineEmits<(e: 'send') => void>();

const controller = useChatController();

function activate(): void {
  activateComposerSend(controller, props.running, props.canSend, () => emit('send'));
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
  color: var(--text-primary);
  background: color-mix(in srgb, var(--border-default) 62.5%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-default);
  cursor: pointer;
  transform: none;
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
.stop-square {
  position: absolute;
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: currentColor;
  opacity: 0;
  transform: scale(0.4);
  transition: opacity 0.2s, transform 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
.run-ring {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  opacity: 0;
  background: conic-gradient(from 0deg, transparent 0 60%, var(--accent-hover) 90%, transparent);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), var(--bg-page) calc(100% - 1.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), var(--bg-page) calc(100% - 1.5px));
  animation: composer-run-spin 1s linear infinite;
  transition: opacity 0.2s;
}
.composer-send.running .send-arrow { opacity: 0; transform: translateY(-10px); }
.composer-send.running .stop-square { opacity: 1; transform: none; }
.composer-send.running .run-ring { opacity: 1; }

@keyframes composer-run-spin { to { transform: rotate(1turn); } }

@media (prefers-reduced-motion: reduce) {
  .composer-send,
  .send-arrow,
  .stop-square,
  .run-ring { animation: none; transition: none; }
}
</style>
