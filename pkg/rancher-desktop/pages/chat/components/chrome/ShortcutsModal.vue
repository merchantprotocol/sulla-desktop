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
  background: rgba(7, 13, 26, 0.7); backdrop-filter: blur(8px);
}
.shortcuts {
  width: 600px; max-width: calc(100vw - 48px);
  background: rgba(20, 30, 42, 0.96);
  border: 1px solid rgba(80, 150, 179, 0.3);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 30px 60px rgba(0,0,0,0.6);
  padding: 24px 28px;
}
.hd { font-family: var(--serif); font-style: italic; font-size: 22px; color: white; margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px 40px; }
.sec {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.25em;
  text-transform: uppercase; color: var(--steel-400);
  margin-bottom: 10px; padding-bottom: 8px;
  border-bottom: 1px solid rgba(80, 150, 179, 0.15);
}
.row {
  display: flex; justify-content: space-between; padding: 6px 0;
  font-family: var(--serif); font-style: italic; font-size: 14px;
  color: var(--read-2);
}
.row kbd {
  font-family: var(--mono); font-style: normal; font-size: 10.5px;
  padding: 2px 7px; border-radius: 4px;
  background: rgba(168, 192, 220, 0.12);
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-100); letter-spacing: 0.08em;
}
.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
