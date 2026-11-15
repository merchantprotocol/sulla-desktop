<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Actions for a turn: Copy, Edit, Reply, Regenerate, Pin, Fork. Under Sulla's
  reply they sit in their own row (never over the next message); the newest
  reply shows them all the time, quietly, and older ones on hover or focus,
  lingering briefly so moving the pointer to them doesn't lose them. Parent
  decides which to show via flags.
-->
<template>
  <div
    class="tact"
    :class="[`tact-${role}`, { 'tact-latest': latest }]"
  >
    <button
      v-if="show.edit"
      type="button"
      class="tact-btn"
      @click="$emit('edit')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>Edit
    </button>
    <button
      v-if="show.copy"
      type="button"
      class="tact-btn"
      :class="{ 'tact-done': copied }"
      :aria-label="copied ? 'Copied' : 'Copy'"
      @click="onCopy"
    >
      <svg v-if="copied" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>{{ copied ? 'Copied' : 'Copy' }}
    </button>
    <button
      v-if="show.quote"
      type="button"
      class="tact-btn"
      title="Reply to this message"
      @click="$emit('quote')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>Reply
    </button>
    <button
      v-if="show.regenerate"
      type="button"
      class="tact-btn tact-icon"
      title="Regenerate"
      aria-label="Regenerate"
      @click="$emit('regenerate')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg>
    </button>
    <button
      v-if="show.pin"
      type="button"
      class="tact-btn tact-icon"
      :class="{ 'tact-on': pinned }"
      :title="pinned ? 'Unpin' : 'Pin'"
      :aria-label="pinned ? 'Unpin' : 'Pin'"
      :aria-pressed="!!pinned"
      @click="$emit('pin')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5" /><path d="M8 3h8l-1 6 3 4H6l3-4z" /></svg>
    </button>
    <button
      v-if="show.fork"
      type="button"
      class="tact-btn tact-icon"
      title="Fork into a new chat"
      aria-label="Fork into a new chat"
      @click="$emit('fork')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  role:      'you' | 'sulla';
  pinned?:   boolean;
  /** The newest reply: its actions stay visible without hovering. */
  latest?:   boolean;
  // Explicit toggles; default shows sensible defaults for each role.
  actions?:  { edit?: boolean; copy?: boolean; regenerate?: boolean; quote?: boolean; pin?: boolean; fork?: boolean };
}>();

const emit = defineEmits<{
  (e: 'edit'): void; (e: 'copy'): void; (e: 'regenerate'): void;
  (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const show = computed(() => {
  if (props.actions) return { edit: false, copy: false, regenerate: false, quote: false, pin: false, fork: false, ...props.actions };
  return props.role === 'you'
    ? { edit: true, copy: true, regenerate: false, quote: false, pin: false, fork: false }
    : { edit: false, copy: true, regenerate: true, quote: true, pin: true, fork: true };
});

/** Copy confirms in place for a moment. */
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function onCopy(): void {
  emit('copy');
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false }, 1200);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names. */
.tact {
  --tact-ink: color-mix(in srgb, var(--text-primary) 72%, var(--bg-surface));
  --tact-ink-quiet: color-mix(in srgb, var(--text-primary) 52%, var(--bg-surface));
  display: flex; align-items: center; gap: 2px;
  font-family: var(--font-body); font-size: 12.5px; letter-spacing: 0; text-transform: none;
  /* Hidden until the turn is hovered or focused; lingers on the way out. */
  opacity: 0; visibility: hidden;
  transition: opacity .15s cubic-bezier(.22, 1, .36, 1) .35s, visibility 0s linear .5s;
}
.chat-turn:hover > .tact,
.chat-turn:focus-within > .tact,
.tact:hover, .tact:focus-within, .tact.tact-latest {
  opacity: 1; visibility: visible;
  transition-delay: 0s, 0s;
}

/* The newest reply: its own row under the text, always there. */
.tact-sulla { min-height: 30px; margin: 6px 0 0 -8px; }
/* Older replies reserve no space: the actions appear at the right of the reply's own
   "SULLA · time" line, which is otherwise empty, so they never cover the next message. */
.tact-sulla:not(.tact-latest) { position: absolute; top: -4px; right: 0; min-height: 0; margin: 0; }
/* Under a user bubble: just below it, with an invisible bridge so the pointer can cross the gap. */
.tact-you { position: absolute; top: 100%; right: 0; padding-top: 4px; }
.tact-you::before { content: ""; position: absolute; left: 0; right: 0; top: -6px; height: 10px; }

.tact-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px;
  border: 0; border-radius: 7px; background: none; color: var(--tact-ink);
  font: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color .15s cubic-bezier(.22, 1, .36, 1), color .15s cubic-bezier(.22, 1, .36, 1);
}
.tact-icon { width: 28px; padding: 0; justify-content: center; }
.tact-btn svg { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.tact-btn:hover { background: color-mix(in srgb, var(--text-primary) 9%, transparent); color: var(--text-primary); }
.tact-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tact-btn.tact-done { color: var(--status-success); }
.tact-btn.tact-on { color: var(--accent); }
/* The newest reply's row is always there, so it stays quiet until hovered. */
.chat-turn:not(:hover) > .tact-latest:not(:focus-within) .tact-btn:not(.tact-done):not(.tact-on) { color: var(--tact-ink-quiet); }
@media (prefers-reduced-motion: reduce) { .tact, .tact-btn { transition: none; } }
</style>
