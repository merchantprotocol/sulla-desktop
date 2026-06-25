<template>
  <div
    ref="terminalElement"
    class="terminal-wrapper"
  />
</template>

<script lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import '@xterm/xterm/css/xterm.css';

export default defineComponent({
  name: 'XTermTerminal',

  props: {
    isDark: {
      type:    Boolean,
      default: true,
    },
    wsUrl: {
      type:    String,
      default: 'ws://127.0.0.1:6108',
    },
    sessionId: {
      type:    String,
      default: '',
    },
    fontSize: {
      type:    Number,
      default: 14,
    },
    fontFamily: {
      type:    String,
      default: 'Menlo, Monaco, "Courier New", monospace',
    },
    command: {
      type:    String,
      default: '',
    },
    readOnly: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['connected', 'disconnected', 'error'],

  setup(props, { emit }) {
    const terminalElement = ref<HTMLElement>();
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let socket: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const getCssVar = (varName: string, fallback: string): string => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

      return value || fallback;
    };

    const getTheme = () => ({
      background:          getCssVar('--bg-surface', props.isDark ? '#1e293b' : '#f8fafc'),
      foreground:          getCssVar('--text-primary', props.isDark ? '#ccc' : '#333'),
      cursor:              getCssVar('--text-primary', props.isDark ? '#ccc' : '#333'),
      selectionBackground: props.isDark ? '#3b82f680' : '#3b82f640',
      selectionForeground: props.isDark ? '#ffffff' : '#000000',
    });

    const sendResize = () => {
      if (!fitAddon || socket?.readyState !== WebSocket.OPEN) return;
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        socket.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows,
        }));
      }
    };

    let fitTimeout: ReturnType<typeof setTimeout> | null = null;
    const fitTerminal = () => {
      if (fitTimeout) clearTimeout(fitTimeout);
      fitTimeout = setTimeout(() => {
        if (!fitAddon || !terminalElement.value) return;
        const { clientWidth, clientHeight } = terminalElement.value;
        if (clientWidth < 10 || clientHeight < 10) return;
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // ignore fit errors during rapid resize
        }
      }, 30);
    };

    const connectWebSocket = () => {
      if (!terminal || !fitAddon) return;

      socket = new WebSocket(props.wsUrl);

      socket.onopen = () => {
        // Send start message to create/join a PTY session in the Lima VM
        const dims = fitAddon!.proposeDimensions();
        socket!.send(JSON.stringify({
          type:      'start',
          sessionId: props.sessionId || undefined,
          cols:      dims?.cols || 80,
          rows:      dims?.rows || 24,
          command:   props.command || undefined,
        }));
        emit('connected');
      };

      socket.onmessage = (event: MessageEvent) => {
        terminal!.write(event.data);
      };

      socket.onclose = () => {
        terminal!.write('\r\n\x1B[1;31mDisconnected.\x1B[0m\r\n');
        emit('disconnected');
      };

      socket.onerror = () => {
        emit('error');
      };
    };

    const initializeTerminal = () => {
      if (!terminalElement.value || terminal) return;

      terminal = new Terminal({
        cursorBlink: true,
        theme:       getTheme(),
        fontFamily:  props.fontFamily,
        fontSize:    props.fontSize,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalElement.value);
      fitAddon.fit();

      terminal.onData((data: string) => {
        if (props.readOnly) return;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      });

      resizeObserver = new ResizeObserver(() => fitTerminal());
      resizeObserver.observe(terminalElement.value);

      connectWebSocket();
    };

    const updateTheme = () => {
      if (terminal) {
        terminal.options.theme = getTheme();
      }
    };

    onMounted(() => {
      initializeTerminal();
    });

    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      socket?.close();
      socket = null;
      terminal?.dispose();
      terminal = null;
    });

    watch(() => props.isDark, updateTheme);

    return {
      terminalElement,
    };
  },
});
</script>

<style scoped>
.terminal-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.terminal-wrapper :deep(.xterm) {
  height: 100%;
  overflow: hidden;
}

.terminal-wrapper :deep(.xterm-viewport) {
  overflow-y: hidden !important;
  background-color: inherit !important;
}

.terminal-wrapper :deep(.xterm-scrollable-element) {
  background-color: var(--bg-surface) !important;
  color: #f1f5f9;
}

.terminal-wrapper :deep(.xterm-scrollable-element .xterm-rows) {
  color: #b2bcb6;
}
</style>
