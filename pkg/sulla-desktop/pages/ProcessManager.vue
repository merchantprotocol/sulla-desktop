<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <main>
    <header>
      <div>
        <p class="eyebrow">
          SULLA DESKTOP · VIRTUAL MACHINE
        </p><h1>Process Manager</h1><p class="muted">
          See where your VM’s resources are going.
        </p>
      </div>
      <button @click="paused = !paused">
        {{ paused ? 'Resume live updates' : 'Pause updates' }}
      </button>
    </header>
    <div
      v-if="error"
      class="notice error"
      role="alert"
    >
      {{ error }} <button
        :disabled="loading"
        @click="refresh"
      >
        Retry
      </button>
    </div>
    <div
      v-if="!snapshot"
      class="empty"
    >
      {{ loading ? 'Connecting to your VM…' : 'No VM data available.' }}
    </div>
    <template v-else>
      <div
        class="status"
        role="status"
      >
        <span :class="['dot', { stale: error || paused }]" />{{ error ? 'Disconnected · showing last reading' : paused ? 'Updates paused' : 'Live · updates every 3 seconds' }}<span>Last reading {{ updated }}</span>
      </div>
      <section
        class="cards"
        aria-label="VM resources"
      >
        <article>
          <h2>Memory</h2><strong>{{ bytes(usedMemory) }} <small>/ {{ bytes(snapshot.memoryTotal) }}</small></strong><progress
            :value="usedMemory"
            :max="snapshot.memoryTotal"
          /><p>{{ bytes(snapshot.memoryAvailable) }} available · {{ memoryPercent.toFixed(0) }}% used</p>
        </article>
        <article>
          <h2>CPU</h2><strong>{{ percent(snapshot.cpu) }} <small>of VM capacity</small></strong><progress
            :value="snapshot.cpu || 0"
            max="100"
          /><p>{{ snapshot.cores }} virtual cores · {{ snapshot.processes.length }} processes</p>
        </article>
        <article><h2>Shared / RAM-backed memory</h2><strong>{{ bytes(snapshot.shared) }}</strong><p>Included in memory usage. Files kept in RAM can fill memory even when no process looks large.</p></article>
      </section>
      <section
        class="notice"
        :class="{ warning: memoryPercent >= 85 || (snapshot.cpu || 0) >= 90 }"
      >
        <strong>{{ pressureTitle }}</strong>
        <p>Largest memory user: {{ memoryLeader?.name || '—' }} ({{ bytes(memoryLeader?.memory || 0) }}). Busiest CPU: {{ cpuLeader?.name || 'Sampling…' }}{{ cpuLeader ? ` (${percent(cpuLeader.cpu)})` : '' }}.</p>
        <p class="muted">
          {{ snapshot.swapTotal ? `Swap: ${bytes(snapshot.swapUsed)} used of ${bytes(snapshot.swapTotal)}.` : 'No swap is configured for this VM.' }} Process memory can share pages; its sum will not equal total memory usage.
        </p>
      </section>
      <div class="toolbar">
        <label>Find a process <input
          v-model="filter"
          placeholder="Name, PID, or user"
          type="search"
        ></label><label>Sort by <select v-model="sort"><option value="memory">Memory</option><option value="cpu">CPU</option><option value="name">Name</option></select></label><span class="muted">{{ rows.length }} processes</span>
      </div>
      <div class="processes">
        <table>
          <thead><tr><th>Process</th><th>PID</th><th>User</th><th>CPU</th><th>Memory</th><th>State</th><th>Controls</th></tr></thead>
          <tbody>
            <tr
              v-for="p in rows"
              :key="`${snapshot.boot}:${p.pid}:${p.started}`"
            >
              <td class="process-name">
                {{ p.name }}
              </td><td class="metric-cell">
                {{ p.pid }}
              </td><td>{{ p.user }}</td><td class="metric-cell">
                {{ percent(p.cpu) }}
              </td><td class="metric-cell">
                {{ bytes(p.memory) }}
              </td><td>
                <span
                  class="process-state-dot"
                  :class="`state-${p.state.toLowerCase()}`"
                />{{ stateName(p.state) }}
              </td><td>
                <span
                  v-if="p.protected"
                  class="protected"
                  :title="p.protected"
                >Protected</span><div
                  v-else
                  class="actions"
                >
                  <button
                    :disabled="!!busy || !!error || paused"
                    @click="terminate(p, 'TERM')"
                  >
                    Quit
                  </button><button
                    class="danger"
                    :disabled="!!busy || !!error || paused"
                    @click="terminate(p, 'KILL')"
                  >
                    Force Quit
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table><p
          v-if="!rows.length"
          class="empty"
        >
          No matching processes.
        </p>
      </div>
      <p class="muted footnote">
        CPU percentages use all VM cores as 100%. Root-owned processes and core services are protected; manage those through their service or container controls. Force Quit affects only the selected process, not its children. Supervisors may restart it.
      </p>
      <details>
        <summary>RAM-backed filesystems</summary><p class="muted">
          These files consume RAM. Duplicate mounts are counted once. This usage overlaps the memory figures above.
        </p><div
          v-for="fs in snapshot.filesystems"
          :key="fs.path"
          class="filesystem"
        >
          <code>{{ fs.path }}</code><progress
            :value="fs.used"
            :max="fs.total || 1"
          /><span>{{ bytes(fs.used) }} / {{ bytes(fs.total) }}</span>
        </div>
      </details>
    </template>
    <p
      v-if="message"
      role="status"
      class="notice"
    >
      {{ message }}
    </p>
  </main>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { withCpu, type VmSnapshot, type VmProcess } from '@pkg/main/processManager/types';

const snapshot = ref<VmSnapshot>();
const error = ref('');
const message = ref('');
const loading = ref(false);
const paused = ref(false);
const busy = ref<number>();
const filter = ref('');
const sort = ref('memory');
const updated = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const usedMemory = computed(() => snapshot.value ? snapshot.value.memoryTotal - snapshot.value.memoryAvailable : 0);
const memoryPercent = computed(() => snapshot.value ? usedMemory.value / snapshot.value.memoryTotal * 100 : 0);
const memoryLeader = computed(() => [...(snapshot.value?.processes || [])].sort((a, b) => b.memory - a.memory)[0]);
const cpuLeader = computed(() => [...(snapshot.value?.processes || [])].filter(p => p.cpu != null).sort((a, b) => (b.cpu || 0) - (a.cpu || 0))[0]);
const pressureTitle = computed(() => memoryPercent.value >= 90 ? 'Memory is nearly full' : (snapshot.value?.cpu || 0) >= 90 ? 'CPU is close to capacity' : memoryPercent.value >= 85 ? 'Memory is getting tight' : 'Resources have room available');
const rows = computed(() => (snapshot.value?.processes || []).filter(p => `${ p.name } ${ p.pid } ${ p.user }`.toLowerCase().includes(filter.value.toLowerCase())).slice().sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name) : sort.value === 'cpu' ? (b.cpu ?? -1) - (a.cpu ?? -1) : b.memory - a.memory));
function bytes(n: number): string {
  if (n >= 1024 ** 3) { return `${ (n / 1024 ** 3).toFixed(1) } GB` }
  return `${ (n / 1024 ** 2).toFixed(1) } MB`;
}
function percent(n?: number | null): string { return n == null ? 'Sampling…' : `${ n.toFixed(1) }%` }
function stateName(state: string): string { return ({ R: 'Running', S: 'Sleeping', D: 'Waiting on I/O', Z: 'Zombie', T: 'Stopped', I: 'Idle' } as Record<string, string>)[state] || state }
async function refresh() {
  if (loading.value || disposed) { return }
  loading.value = true;
  try {
    const raw: VmSnapshot = await ipcRenderer.invoke('vm-process-manager:snapshot');
    if (disposed) { return }
    snapshot.value = withCpu(raw, snapshot.value);
    updated.value = new Date().toLocaleTimeString();
    error.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) } finally { loading.value = false }
}
async function tick() {
  if (!paused.value && !document.hidden) { await refresh() }
  if (!disposed) { timer = setTimeout(tick, 3000) }
}
async function terminate(p: VmProcess, signal: 'TERM' | 'KILL') {
  if (!snapshot.value || busy.value) { return }
  busy.value = p.pid;
  message.value = '';
  try {
    const result = await ipcRenderer.invoke('vm-process-manager:terminate', { pid: p.pid, started: p.started, boot: snapshot.value.boot, signal });
    if (result.sent) { message.value = `${ signal === 'KILL' ? 'Force Quit' : 'Quit' } signal sent to ${ p.name } (PID ${ p.pid }).`; await refresh() }
  } catch (e) { message.value = e instanceof Error ? e.message : String(e) } finally { busy.value = undefined }
}
onMounted(tick);
onUnmounted(() => { disposed = true; clearTimeout(timer) });
</script>

<style scoped>
:global(body) { margin: 0; background: var(--accent); color: var(--accent); font-family: var(--font-body); font-size: 14px; }
* { box-sizing: border-box; } main { padding: 28px; max-width: 1500px; margin: auto; } header { display: flex; justify-content: space-between; align-items: center; gap: 20px; } h1 { font-size: 30px; margin: 4px 0 8px; font-weight: 600; } h2 { margin: 0 0 15px; font-size: 14px; font-weight: 500; color: var(--accent); } p { line-height: 1.5; margin: 8px 0; } .eyebrow { color: var(--accent); font-size: 11px; letter-spacing: 1.5px; } .muted, small { color: var(--accent); } .status { display: flex; align-items: center; gap: 8px; color: var(--accent); margin: 22px 0; font-size: 12px; } .status > span:last-child { margin-left: auto; } .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); } .dot.stale { background: var(--accent); } .cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; } article { background: var(--accent); border: 1px solid var(--accent); padding: 20px; border-radius: 12px; } article strong { display: block; font-size: 25px; font-weight: 500; } article small { font-size: 12px; } article p { font-size: 12px; } progress { width: 100%; height: 7px; accent-color: var(--accent); margin-top: 16px; } .notice { padding: 14px 18px; margin: 20px 0; background: var(--accent); border: 1px solid var(--accent); border-radius: 10px; } .notice p { font-size: 12px; } .warning { border-color: var(--accent); } .error { border-color: var(--accent); } .toolbar { display: flex; align-items: end; gap: 16px; margin: 24px 0 14px; } label { display: grid; gap: 7px; font-size: 12px; color: var(--accent); } .toolbar > span { margin-left: auto; padding-bottom: 8px; } input, select, button { color: var(--accent); background: var(--accent); border: 1px solid var(--accent); border-radius: 6px; padding: 8px 10px; font: inherit; } input { width: 270px; } button { cursor: pointer; white-space: nowrap; } button:hover { background: var(--accent); } button:disabled { opacity: .4; cursor: default; } button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; } .danger { color: var(--accent); } .processes { max-height: 420px; overflow: auto; border: 1px solid var(--accent); border-radius: 10px; } table { width: 100%; border-collapse: collapse; font-size: 12px; } th { background: var(--accent); position: sticky; top: 0; color: var(--accent); text-align: left; font-weight: 500; } th, td { padding: 12px; border-bottom: 1px solid var(--accent); } .process-name { font-weight: 600; max-width: 220px; overflow-wrap: anywhere; } .actions { display: flex; gap: 6px; } .actions button { font-size: 11px; padding: 5px 8px; } .protected { color: var(--accent); cursor: help; } .footnote { font-size: 12px; margin: 14px 0 24px; } details { background: var(--accent); padding: 16px; border-radius: 10px; } summary { cursor: pointer; } details p { font-size: 12px; } .filesystem { display: grid; grid-template-columns: 180px 1fr 160px; align-items: center; gap: 20px; margin-top: 12px; font-size: 12px; } .filesystem progress { margin: 0; } .empty { padding: 30px; color: var(--accent); text-align: center; }
</style>

<style scoped>
:global(body) {
  background: var(--bg-page);
  color: var(--text-secondary);
}

main {
  min-height: 100vh;
  padding: 34px 38px 42px;
  background: radial-gradient(90% 60% at 0% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 58%), var(--bg-page);
}

header {
  padding-bottom: 4px;
  animation: noir-process-in 0.48s cubic-bezier(.22, 1, .36, 1) both;
}

h1 {
  color: var(--text-primary);
  font-family: var(--font-display), Georgia, serif;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.eyebrow {
  color: var(--accent-hover);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.14em;
}

.muted,
small { color: var(--text-dim); }
.status {
  margin: 20px 0 14px;
  padding: 10px 12px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--border-subtle) 15.625%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-subtle) 37.5%, transparent);
  border-radius: 12px;
  font-family: ui-monospace, 'SF Mono', monospace;
}

.dot {
  background: var(--status-success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-success) 70%, transparent);
}
.dot.stale {
  background: var(--status-warning);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-warning) 60%, transparent);
}

.cards { gap: 12px; }
article,
.notice,
details {
  background: color-mix(in srgb, var(--border-subtle) 21.875%, transparent);
  border-color: var(--border-subtle);
  border-radius: 18px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-subtle) 12.5%, transparent);
}

article:first-child {
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent) 3%, transparent));
  border-color: color-mix(in srgb, var(--accent-hover) 25%, transparent);
}

article h2 {
  color: var(--text-muted);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

article strong {
  color: var(--text-primary);
  font-family: var(--font-display), Georgia, serif;
  font-size: 27px;
}

progress { accent-color: var(--accent); }
.notice.warning { border-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }
.notice.error { border-color: color-mix(in srgb, var(--status-error) 35%, transparent); }

input,
select,
button {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-page) 68%, transparent);
  border-color: color-mix(in srgb, var(--border-subtle) 75%, transparent);
  border-radius: 12px;
}

button { transition: background 0.16s, border-color 0.16s, transform 0.4s cubic-bezier(.22, 1, .36, 1); }
button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--accent-hover) 35%, transparent);
  transform: translateY(-1px);
}

.processes {
  max-height: 440px;
  padding: 0 8px 8px;
  border-color: var(--border-subtle);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-page) 42%, transparent);
}

table { border-collapse: separate; border-spacing: 0 5px; }
th {
  top: 0;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg-page) 96%, transparent);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

td {
  padding: 11px 12px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--border-subtle) 17.5%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--border-subtle) 37.5%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 37.5%, transparent);
  transition: background 0.15s;
}

tbody tr:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
td:first-child { border-left: 1px solid color-mix(in srgb, var(--border-subtle) 37.5%, transparent); border-radius: 11px 0 0 11px; }
td:last-child { border-right: 1px solid color-mix(in srgb, var(--border-subtle) 37.5%, transparent); border-radius: 0 11px 11px 0; }
.process-name { color: var(--text-secondary); }
.metric-cell {
  color: var(--text-primary);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-variant-numeric: tabular-nums;
}

.process-state-dot { display: none; }
.process-state-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--text-dim);
}
.process-state-dot.state-r { background: var(--status-success); box-shadow: 0 0 7px color-mix(in srgb, var(--status-success) 65%, transparent); }
.process-state-dot.state-d,
.process-state-dot.state-t { background: var(--status-warning); box-shadow: 0 0 7px color-mix(in srgb, var(--status-warning) 55%, transparent); }
.process-state-dot.state-z { background: var(--status-error); box-shadow: 0 0 7px color-mix(in srgb, var(--status-error) 55%, transparent); }

.actions { opacity: 0; transition: opacity 0.15s; }
tbody tr:hover .actions { opacity: 1; }
.filesystem code,
.filesystem span { color: var(--accent); font-family: ui-monospace, 'SF Mono', monospace; }

.metric-cell,
.filesystem code,
.filesystem span { color: var(--accent-hover); }

@keyframes noir-process-in {
  from { opacity: 0; transform: translateY(8px); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: none; }
}

@media (prefers-reduced-motion: reduce) {
  header { animation: none; }
  button { transition-duration: 0.01ms; }
}
</style>
