<!-- "Sulla is speaking" stage-direction with wave + stop button. -->
<template>
  <div class="tts-speaking">
    <span class="label">Sulla speaking</span>
    <span class="wave" aria-hidden="true">
      <span v-for="i in 10" :key="i" />
    </span>
    <button type="button" class="stop-tts" @click="controller.stopTTS(msg.id)">
      Stop · ⌘.
    </button>
  </div>
</template>

<script setup lang="ts">
import type { TtsMessage } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

defineProps<{ msg: TtsMessage }>();
const controller = useChatController();
</script>

<style scoped>
.tts-speaking {
  padding: 14px 0 14px 22px;
  border-left: 1px solid rgba(80, 150, 179, 0.45);
  position: relative;
  display: flex; align-items: center; gap: 16px;
}
.tts-speaking::before {
  content: ""; position: absolute; left: -4px; top: 20px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 14px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.label {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-400);
  font-weight: 700; flex-shrink: 0;
}
.wave { flex: 1; display: flex; align-items: center; gap: 3px; height: 20px; }
.wave span {
  display: block; width: 2px; border-radius: 1px;
  background: var(--steel-400); box-shadow: 0 0 3px rgba(106, 176, 204, 0.4);
  animation: wave-bar 0.8s ease-in-out infinite;
}
.wave span:nth-child(1)  { animation-delay: 0s; }
.wave span:nth-child(2)  { animation-delay: 0.08s; }
.wave span:nth-child(3)  { animation-delay: 0.16s; }
.wave span:nth-child(4)  { animation-delay: 0.22s; }
.wave span:nth-child(5)  { animation-delay: 0.3s; }
.wave span:nth-child(6)  { animation-delay: 0.1s; }
.wave span:nth-child(7)  { animation-delay: 0.18s; }
.wave span:nth-child(8)  { animation-delay: 0.26s; }
.wave span:nth-child(9)  { animation-delay: 0.04s; }
.wave span:nth-child(10) { animation-delay: 0.14s; }
@keyframes wave-bar { 0%, 100% { height: 20%; } 50% { height: 90%; } }
.stop-tts {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--read-3);
  padding: 5px 11px; border-radius: 4px;
  background: transparent; border: 1px solid rgba(80, 150, 179, 0.3);
  cursor: pointer; flex-shrink: 0; transition: all 0.15s ease;
}
.stop-tts:hover { color: white; border-color: var(--steel-400); background: rgba(80, 150, 179, 0.12); }
</style>
