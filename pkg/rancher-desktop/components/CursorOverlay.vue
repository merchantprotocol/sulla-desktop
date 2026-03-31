<template>
  <div v-if="visible" class="cursor-overlay">
    <!-- Animated cursor -->
    <div
      class="cursor-pointer"
      :style="cursorStyle"
    >
      <!-- Cursor icon -->
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M3 2L3 17L7.5 12.5L11.5 18L14 16.5L10 11L16 11L3 2Z"
          fill="white"
          stroke="black"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
      <!-- Click ripple -->
      <div v-if="showRipple" class="click-ripple" />
      <!-- Typing indicator -->
      <div v-if="showTyping" class="typing-badge">
        {{ typingText }}
      </div>
      <!-- Scroll indicator -->
      <div v-if="showScroll" class="scroll-badge">
        {{ scrollDirection === 'down' ? '↓' : '↑' }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

const props = defineProps<{
  assetId?: string;
}>();

const visible = ref(false);
const cursorX = ref(0);
const cursorY = ref(0);
const showRipple = ref(false);
const showTyping = ref(false);
const showScroll = ref(false);
const typingText = ref('');
const scrollDirection = ref('down');

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

const cursorStyle = computed(() => ({
  transform: `translate(${ cursorX.value }px, ${ cursorY.value }px)`,
  transition: 'transform 0.3s ease-out',
}));

function handleCursorEvent(data: any) {
  if (data.type !== 'cursor_move') return;
  if (props.assetId && data.assetId && data.assetId !== props.assetId) return;

  visible.value = true;
  cursorX.value = data.x;
  cursorY.value = data.y;

  // Reset all indicators
  showRipple.value = false;
  showTyping.value = false;
  showScroll.value = false;

  switch (data.action) {
    case 'click':
    case 'drag':
      // Show ripple animation
      showRipple.value = true;
      setTimeout(() => { showRipple.value = false }, 400);
      break;
    case 'type':
      showTyping.value = true;
      typingText.value = data.text ? data.text.slice(0, 20) : '...';
      setTimeout(() => { showTyping.value = false }, 1500);
      break;
    case 'scroll':
      showScroll.value = true;
      scrollDirection.value = (data.deltaY || 0) > 0 ? 'down' : 'up';
      setTimeout(() => { showScroll.value = false }, 800);
      break;
  }

  // Auto-hide cursor after inactivity
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { visible.value = false }, 5000);
}

onMounted(() => {
  const wsService = getWebSocketClientService();
  const channel = 'sulla-desktop';

  unsubscribe = wsService.onMessage(channel, (msg: any) => {
    if (msg.type === 'progress_update' && msg.data) {
      handleCursorEvent(msg.data);
    }
  });
});

onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe();
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<style scoped>
.cursor-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 9999;
  overflow: hidden;
}

.cursor-pointer {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.3));
}

.click-ripple {
  position: absolute;
  top: 0;
  left: 0;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(59, 130, 246, 0.3);
  border: 2px solid rgba(59, 130, 246, 0.6);
  transform: translate(-10px, -10px);
  animation: ripple-expand 0.4s ease-out forwards;
}

@keyframes ripple-expand {
  0% {
    transform: translate(-10px, -10px) scale(0.3);
    opacity: 1;
  }
  100% {
    transform: translate(-10px, -10px) scale(2);
    opacity: 0;
  }
}

.typing-badge {
  position: absolute;
  top: 20px;
  left: 16px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: badge-fade-in 0.2s ease-out;
}

.scroll-badge {
  position: absolute;
  top: 20px;
  left: 16px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  animation: badge-fade-in 0.2s ease-out;
}

@keyframes badge-fade-in {
  0% { opacity: 0; transform: translateY(-4px); }
  100% { opacity: 1; transform: translateY(0); }
}
</style>
