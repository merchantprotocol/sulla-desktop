<template>
  <div class="recipe-logs">
    <div
      ref="termEl"
      class="term-wrap"
    />
    <div
      v-if="error"
      class="log-error"
    >
      {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ slug: string; service?: string }>();

const termEl = ref<HTMLElement | null>(null);
const error = ref('');

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let sessionId = '';
let resizeObserver: ResizeObserver | null = null;

async function startSession() {
  if (!termEl.value) return;

  error.value = '';

  terminal = new Terminal({
    disableStdin:    true,
    convertEol:      true,
    scrollback:      50000,
    wordSeparator:   ' ()[]{}\'"',
    theme: {
      background: '#0d0d0d',
      foreground: '#d4d4d4',
      cursor:     '#39ff14',
    },
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(termEl.value);
  fitAddon.fit();

  resizeObserver = new ResizeObserver(() => { try { fitAddon?.fit(); } catch { /**/ } });
  resizeObserver.observe(termEl.value);

  try {
    const result = await ipcRenderer.invoke('recipe-logs-start', props.slug, props.service || undefined) as { sessionId?: string; error?: string };
    if (result.error || !result.sessionId) {
      error.value = result.error ?? 'Failed to start log stream';
      return;
    }
    sessionId = result.sessionId;
  } catch (err) {
    error.value = String(err);
    return;
  }

  ipcRenderer.on('recipe-logs-data', onLogsData);
  ipcRenderer.on('recipe-logs-end', onLogsEnd);
}

function onLogsData(_evt: unknown, sid: string, chunk: string) {
  if (sid !== sessionId) return;
  terminal?.write(chunk);
}

function onLogsEnd(_evt: unknown, sid: string) {
  if (sid !== sessionId) return;
  terminal?.write('\r\n\x1b[33m[stream ended — reconnecting…]\x1b[0m\r\n');
  setTimeout(async() => {
    if (!termEl.value) return;
    await stopSession();
    await startSession();
  }, 2000);
}

async function stopSession() {
  ipcRenderer.off('recipe-logs-data', onLogsData);
  ipcRenderer.off('recipe-logs-end', onLogsEnd);
  resizeObserver?.disconnect();
  if (sessionId) {
    await ipcRenderer.invoke('recipe-logs-stop', sessionId).catch(() => {});
    sessionId = '';
  }
  terminal?.dispose();
  terminal = null;
}

watch([() => props.slug, () => props.service], async() => {
  await stopSession();
  await startSession();
});

onMounted(startSession);
onBeforeUnmount(stopSession);
</script>

<style scoped>
.recipe-logs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.term-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 4px;
}

.log-error {
  padding: 8px 12px;
  color: var(--danger);
  font-size: 12px;
  font-family: var(--font-mono);
}
</style>
