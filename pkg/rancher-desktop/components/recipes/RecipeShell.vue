<template>
  <div class="recipe-shell">
    <div
      v-if="!containerName"
      class="shell-no-container"
    >
      <span v-if="loading">Finding running container…</span>
      <span v-else-if="pickError">{{ pickError }}</span>
      <span v-else>No running container found. Start the recipe first.</span>
    </div>
    <template v-else>
      <div class="shell-bar">
        <span class="shell-label">docker exec -it {{ containerName }} /bin/sh</span>
        <button
          class="btn-reconnect"
          type="button"
          @click="reconnect"
        >
          Reconnect
        </button>
      </div>
      <div
        ref="termEl"
        class="term-wrap"
      />
    </template>
    <div
      v-if="shellError"
      class="shell-error"
    >
      {{ shellError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  slug: string;
  containers: Array<{ name: string; state: string }>;
  preferredContainer?: string;
}>();

const termEl = ref<HTMLElement | null>(null);
const containerName = ref('');
const loading = ref(true);
const pickError = ref('');
const shellError = ref('');

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let sessionId = '';
let resizeObserver: ResizeObserver | null = null;

function pickContainer(): string {
  if (props.preferredContainer) {
    const preferred = props.containers.find(c => c.name === props.preferredContainer && c.state === 'running');
    if (preferred) return preferred.name;
  }
  const running = props.containers.find(c => c.state === 'running');

  return running?.name ?? '';
}

async function openShell() {
  const name = pickContainer();
  loading.value = false;
  if (!name) {
    containerName.value = '';
    return;
  }
  containerName.value = name;

  // Wait a tick for the DOM to mount the termEl after containerName is set
  await new Promise(r => setTimeout(r, 50));
  if (!termEl.value) return;

  shellError.value = '';

  terminal = new Terminal({
    disableStdin: false,
    convertEol:   true,
    scrollback:   10000,
    cursorBlink:  true,
    theme: {
      background: '#0d0d0d',
      foreground: '#d4d4d4',
      cursor:     '#39ff14',
    },
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termEl.value);
  fitAddon.fit();

  resizeObserver = new ResizeObserver(() => {
    try {
      fitAddon?.fit();
      if (sessionId && terminal) {
        const dims = fitAddon?.proposeDimensions();
        if (dims) {
          ipcRenderer.invoke('recipe-shell-resize', sessionId, dims.cols, dims.rows).catch(() => {});
        }
      }
    } catch { /**/ }
  });
  resizeObserver.observe(termEl.value);

  const dims = fitAddon.proposeDimensions() ?? { cols: 120, rows: 30 };
  const result = await ipcRenderer.invoke(
    'recipe-shell-open',
    props.slug,
    name,
    dims.cols,
    dims.rows,
  ) as { sessionId?: string; error?: string };

  if (result.error || !result.sessionId) {
    shellError.value = result.error ?? 'Failed to open shell';
    return;
  }

  sessionId = result.sessionId;
  ipcRenderer.on('recipe-shell-data', onShellData);
  ipcRenderer.on('recipe-shell-exit', onShellExit);

  terminal.onData((data: string) => {
    if (sessionId) {
      ipcRenderer.invoke('recipe-shell-input', sessionId, data).catch(() => {});
    }
  });
}

function onShellData(_evt: unknown, sid: string, data: string) {
  if (sid !== sessionId) return;
  terminal?.write(data);
}

function onShellExit(_evt: unknown, sid: string, exitCode: number) {
  if (sid !== sessionId) return;
  terminal?.write(`\r\n\x1b[33m[shell exited with code ${ exitCode }]\x1b[0m\r\n`);
  sessionId = '';
}

async function closeShell() {
  ipcRenderer.off('recipe-shell-data', onShellData);
  ipcRenderer.off('recipe-shell-exit', onShellExit);
  resizeObserver?.disconnect();
  if (sessionId) {
    await ipcRenderer.invoke('recipe-shell-close', sessionId).catch(() => {});
    sessionId = '';
  }
  terminal?.dispose();
  terminal = null;
}

async function reconnect() {
  await closeShell();
  await openShell();
}

watch(() => props.containers, async() => {
  await closeShell();
  await openShell();
});

watch(() => props.slug, async() => {
  await closeShell();
  containerName.value = '';
  loading.value = true;
  await openShell();
});

onMounted(openShell);
onBeforeUnmount(closeShell);
</script>

<style scoped>
.recipe-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.shell-no-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  font-family: var(--font-mono);
}

.shell-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}

.shell-label {
  flex: 1;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-reconnect {
  font-size: 11px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.btn-reconnect:hover {
  background: var(--surface-3);
  color: var(--text);
}

.term-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 4px;
}

.shell-error {
  padding: 8px 12px;
  color: var(--danger);
  font-size: 12px;
  font-family: var(--font-mono);
}
</style>
