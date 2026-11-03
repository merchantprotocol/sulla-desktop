<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Transition name="veil">
    <div v-if="open" class="modal-veil" @click.self="controller.closeModal()">
      <div class="shortcuts">
        <div class="hd">Keyboard shortcuts</div>
        <div class="grid">
          <div>
            <div class="sec">Conversation</div>
            <div class="row"><span>Send</span><kbd>⏎</kbd></div>
            <div class="row"><span>Newline</span><kbd>⇧⏎</kbd></div>
            <div class="row"><span>Commands</span><kbd>/</kbd></div>
            <div class="row"><span>Mention</span><kbd>@</kbd></div>
            <div class="row"><span>Search</span><kbd>⌘F</kbd></div>
            <div class="row"><span>New chat</span><kbd>⌘N</kbd></div>
          </div>
          <div>
            <div class="sec">Model &amp; voice</div>
            <div class="row"><span>Switch model</span><kbd>⌘K</kbd></div>
            <div class="row"><span>Token usage</span><kbd>⌘I</kbd></div>
            <div class="row"><span>Voice toggle</span><kbd>⌘/</kbd></div>
            <div class="row"><span>Stop run</span><kbd>Esc</kbd></div>
            <div class="row"><span>Continue</span><kbd>⌘↵</kbd></div>
            <div class="row"><span>Toggle history</span><kbd>⌘⇧H</kbd></div>
            <div class="row"><span>Help</span><kbd>?</kbd></div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const open = computed(() => controller.modals.value.which === 'shortcuts');
</script>

<style scoped>
.modal-veil {
  position: absolute; inset: 0; z-index: 80;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
  background: var(--bg-overlay); backdrop-filter: blur(8px);
}
.shortcuts {
  width: 600px; max-width: calc(100vw - 48px);
  background: var(--bg-elevated);
  border: 1px solid var(--accent-glow);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 30px 60px var(--bg-page);
  padding: 24px 28px;
}
.hd { font-family: var(--font-display); font-style: italic; font-size: 22px; color: var(--text-on-accent); margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px 40px; }
.sec {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.25em;
  text-transform: uppercase; color: var(--accent-hover);
  margin-bottom: 10px; padding-bottom: 8px;
  border-bottom: 1px solid var(--accent-dim);
}
.row {
  display: flex; justify-content: space-between; padding: 6px 0;
  font-family: var(--font-display); font-style: italic; font-size: 14px;
  color: var(--text-primary);
}
.row kbd {
  font-family: var(--font-mono); font-style: normal; font-size: 10.5px;
  padding: 2px 7px; border-radius: 4px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  color: var(--text-secondary); letter-spacing: 0.08em;
}
.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
