<template>
  <div class="tl-viewer" :class="{ dark: isDark }">
    <div class="tl-header">
      <span class="tl-title">Training Log</span>
      <span v-if="logFilename" class="tl-filename">{{ logFilename }}</span>
      <span v-if="running" class="tl-running-badge">Running</span>
      <div style="flex:1"></div>
      <label class="tl-autoscroll">
        <input type="checkbox" v-model="autoScroll" />
        Auto-scroll
      </label>
    </div>
    <div ref="logContainer" class="tl-log-container" @scroll="onScroll">
      <pre class="tl-log-content">{{ logContent || 'Waiting for output…' }}</pre>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';

const { ipcRenderer } = require('electron');

export default defineComponent({
  name: 'TrainingLogViewer',
  props: {
    isDark:      { type: Boolean, default: false },
    logFilename: { type: String, default: '' },
  },

  setup(props) {
    const logContent = ref('');
    const running = ref(true);
    const autoScroll = ref(true);
    const logContainer = ref<HTMLElement | null>(null);
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let userScrolledUp = false;

    async function pollLog() {
      if (!props.logFilename) {
        console.warn('[TrainingLogViewer] pollLog skipped: no logFilename prop');
        return;
      }
      try {
        const content = await ipcRenderer.invoke('training-log-read', props.logFilename);
        if (content !== logContent.value) {
          logContent.value = content;
          if (autoScroll.value) {
            await nextTick();
            scrollToBottom();
          }
        }
      } catch (err) {
        console.warn('[TrainingLogViewer] training-log-read failed:', err);
      }

      try {
        const status = await ipcRenderer.invoke('training-status');
        running.value = status.running;
        if (!status.running) {
          console.log('[TrainingLogViewer] training completed, doing final read');
          // Final read
          try {
            logContent.value = await ipcRenderer.invoke('training-log-read', props.logFilename);
          } catch { /* ok */ }
          stopPolling();
        }
      } catch { /* ok */ }
    }

    function scrollToBottom() {
      const el = logContainer.value;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }

    function onScroll() {
      const el = logContainer.value;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!atBottom) {
        userScrolledUp = true;
        autoScroll.value = false;
      } else if (userScrolledUp) {
        userScrolledUp = false;
        autoScroll.value = true;
      }
    }

    function startPolling() {
      stopPolling();
      pollLog();
      pollTimer = setInterval(pollLog, 1500);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    watch(() => props.logFilename, (newVal) => {
      if (newVal) {
        logContent.value = '';
        running.value = true;
        autoScroll.value = true;
        startPolling();
      }
    });

    onMounted(() => {
      if (props.logFilename) {
        startPolling();
      }
    });

    onBeforeUnmount(() => {
      stopPolling();
    });

    return {
      logContent,
      running,
      autoScroll,
      logContainer,
      onScroll,
    };
  },
});
</script>

<style>
.tl-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-family: var(--font-mono);
}
.tl-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--bg-surface-hover);
  font-size: var(--fs-body-sm);
  flex-shrink: 0;
}
.tl-title {
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}
.tl-filename {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.tl-running-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  background: var(--bg-info);
  color: var(--text-info);
  animation: tl-pulse 1.5s ease-in-out infinite;
}
@keyframes tl-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.tl-autoscroll {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.tl-autoscroll input {
  margin: 0;
  cursor: pointer;
}
.tl-log-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  padding: 8px 12px;
  background: var(--bg-page);
}
.tl-log-content {
  margin: 0;
  font-size: var(--fs-body-sm);
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
