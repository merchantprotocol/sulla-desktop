<template>
  <div class="nx-shell">
    <div ref="output" class="nx-shell-output" aria-live="polite">
      <div v-for="(line, index) in lines" :key="index" :class="line.kind">
        {{ line.text }}
      </div>
    </div>
    <form class="nx-shell-prompt" @submit.prevent="run">
      <span>{{ containerName }} $</span
      ><input
        v-model="command"
        :disabled="busy || !running"
        aria-label="Shell command"
        autocomplete="off"
        placeholder="Type a command and press Return"
      /><button class="nx-button" :disabled="busy || !running">Run</button>
    </form>
    <p v-if="!running" class="nx-muted">
      Start this container to use its shell.
    </p>
  </div>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
const props = defineProps<{
  containerId: string;
  containerName: string;
  running: boolean;
  namespace?: string;
}>();
const command = ref('');
const busy = ref(false);
const output = ref<HTMLElement>();
const lines = ref<{ kind: string; text: string }[]>([
  {
    kind: 'hint',
    text: 'Commands run inside the container. Output streams here as it arrives.',
  },
]);
let processHandle: any;
async function run() {
  const value = command.value.trim();
  if (!value || busy.value || !window.ddClient) return;
  command.value = '';
  busy.value = true;
  lines.value.push({ kind: 'command', text: `$ ${value}` });
  const options: any = {
    cwd: '/',
    stream: {
      splitOutputLines: false,
      onOutput: (data: any) => {
        const text = data.stdout || data.stderr;
        if (text) {
          lines.value.push({ kind: data.stderr ? 'error' : 'output', text });
          nextTick(() =>
            output.value?.scrollTo({ top: output.value.scrollHeight }),
          );
        }
      },
      onError: (error: any) => {
        lines.value.push({
          kind: 'error',
          text: error?.message || String(error),
        });
        busy.value = false;
      },
      onClose: () => {
        busy.value = false;
        processHandle = undefined;
      },
    },
  };
  if (props.namespace) options.namespace = props.namespace;
  processHandle = window.ddClient.docker.cli.exec(
    'exec',
    ['-i', props.containerId, 'sh', '-lc', value],
    options,
  );
}
onBeforeUnmount(() => processHandle?.close());
</script>
<style scoped>
.nx-shell {
  display: flex;
  flex-direction: column;
  min-height: 420px;
  background: #0d1420;
  border-radius: 10px;
  overflow: hidden;
  color: #dce6ef;
  font: 13px/1.55 var(--font-mono, monospace);
}
.nx-shell-output {
  flex: 1;
  min-height: 350px;
  max-height: 55vh;
  overflow: auto;
  padding: 18px;
  white-space: pre-wrap;
}
.command {
  color: #70b7d3;
}
.error {
  color: #f48a8a;
}
.hint {
  color: #82909e;
}
.nx-shell-prompt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid #263341;
}
.nx-shell-prompt span {
  color: #70b7d3;
}
.nx-shell-prompt input {
  flex: 1;
  border: 0;
  background: transparent;
  color: inherit;
  outline: none;
  font: inherit;
}
.nx-button {
  padding: 6px 12px;
}
.nx-muted {
  padding: 0 16px 12px;
  color: #82909e;
}
</style>
