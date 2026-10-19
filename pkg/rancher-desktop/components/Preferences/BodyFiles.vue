<script lang="ts">
import { defineComponent } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface FileRootView {
  id:            string;
  name:          string;
  path:          string;
  syncMode:      'local' | 'server';
  paused:        boolean;
  exclusions:    string[];
  state?:        'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached';
  pendingFiles?: number;
  lastError?:    string;
  lastScanAt?:   string;
  lastSyncAt?:   string;
  activation:    'active' | 'pending-restart' | 'offline';
  removable:     boolean;
}

export default defineComponent({
  name: 'preferences-body-files',
  data() {
    return { roots: [] as FileRootView[], loading: true, error: '', saving: new Set<string>() };
  },
  async mounted() { await this.load() },
  methods: {
    async load() {
      this.loading = true; this.error = '';
      try { this.roots = await ipcRenderer.invoke('files-preferences:list-roots') } catch (error) { this.error = error instanceof Error ? error.message : String(error) } finally { this.loading = false }
    },
    async addRoot() {
      this.error = '';
      try { const root = await ipcRenderer.invoke('files-preferences:add-root'); if (root) this.roots.push(root); } catch (error) { this.error = error instanceof Error ? error.message : String(error) }
    },
    async update(root:FileRootView, changes:Partial<Pick<FileRootView, 'paused' | 'syncMode' | 'exclusions'>>) {
      this.saving.add(root.id); this.error = '';
      try {
        const updated = await ipcRenderer.invoke('files-preferences:update-root', { id: root.id, ...changes });
        Object.assign(root, updated);
      } catch (error) { this.error = error instanceof Error ? error.message : String(error) } finally { this.saving.delete(root.id) }
    },
    async saveExclusions(root:FileRootView, value:string) {
      await this.update(root, { exclusions: value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) });
    },
    updateSyncMode(root:FileRootView, event:Event) { return this.update(root, { syncMode: (event.target as HTMLSelectElement).value as 'local' | 'server' }) },
    saveExclusionEvent(root:FileRootView, event:Event) { return this.saveExclusions(root, (event.target as HTMLTextAreaElement).value) },
    async removeRoot(root:FileRootView) {
      const result = await ipcRenderer.invoke('show-message-box', {
        type:     'warning',
        title:    'Stop tracking folder?',
        message:  `Stop tracking ${ root.name }?`,
        detail:   'The source folder and its files will not be deleted. Existing encrypted versions remain in Sulla Files.',
        buttons:  ['Stop tracking', 'Cancel'],
        cancelId: 1,
      });
      if (result.response !== 0) return;
      this.saving.add(root.id);
      try { await ipcRenderer.invoke('files-preferences:remove-root', root.id); this.roots = this.roots.filter(item => item.id !== root.id) } catch (error) { this.error = error instanceof Error ? error.message : String(error) } finally { this.saving.delete(root.id) }
    },
    stateLabel(root:FileRootView):string {
      if (root.activation === 'pending-restart') return 'Ready after Sulla restarts';
      if (root.activation === 'offline') return 'Files service offline';
      if (root.state === 'idle') return 'Up to date';
      return root.state ? root.state[0].toUpperCase() + root.state.slice(1) : 'Checking';
    },
    time(value?:string):string { return value ? new Date(value).toLocaleString() : 'Not yet' },
  },
});
</script>

<template>
  <div class="files-preferences">
    <div class="files-heading">
      <div>
        <h3>Tracked folders</h3>
        <p class="description">
          Each folder has its own scan history and sync policy. Sulla never moves or deletes the source when tracking stops.
        </p>
      </div>
      <button
        class="btn role-primary"
        :disabled="loading"
        @click="addRoot"
      >
        Add folder
      </button>
    </div>
    <div
      v-if="error"
      class="files-error"
      role="alert"
    >
      {{ error }}
    </div>
    <div
      v-if="loading"
      class="files-empty"
    >
      Loading tracked folders…
    </div>
    <div
      v-else
      class="root-list"
    >
      <section
        v-for="root in roots"
        :key="root.id"
        class="root-card"
      >
        <div class="root-summary">
          <div class="root-name">
            <strong>{{ root.name }}</strong>
            <span class="root-path">{{ root.path }}</span>
          </div>
          <span
            class="root-state"
            :class="root.state"
          >{{ stateLabel(root) }}</span>
        </div>
        <div class="root-meta">
          <span>Scan: {{ time(root.lastScanAt) }}</span><span>Sync: {{ time(root.lastSyncAt) }}</span><span v-if="root.pendingFiles">{{ root.pendingFiles }} pending</span>
        </div>
        <p
          v-if="root.lastError"
          class="root-error"
        >
          {{ root.lastError }}
        </p>
        <div class="root-controls">
          <label>Storage
            <select
              :value="root.syncMode"
              :disabled="saving.has(root.id)"
              @change="updateSyncMode(root, $event)"
            >
              <option value="local">This Mac only</option><option value="server">Configured Files server</option>
            </select>
          </label>
          <button
            class="btn role-secondary"
            :disabled="saving.has(root.id)"
            @click="update(root, { paused: !root.paused })"
          >
            {{ root.paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            v-if="root.removable"
            class="btn role-secondary remove"
            :disabled="saving.has(root.id)"
            @click="removeRoot(root)"
          >
            Stop tracking
          </button>
        </div>
        <label class="exclusions">Exclusions <small>One glob per line</small>
          <textarea
            :value="root.exclusions.join('\n')"
            :disabled="saving.has(root.id)"
            rows="3"
            placeholder=".git/&#10;node_modules/"
            @change="saveExclusionEvent(root, $event)"
          />
        </label>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.files-preferences { padding: var(--preferences-content-padding, 1.5rem); }
.files-heading, .root-summary, .root-controls, .root-meta { display:flex; align-items:center; gap:.75rem; }
.files-heading { justify-content:space-between; align-items:flex-start; }
.files-heading h3 { margin:0 0 .25rem; }
.files-heading .description { margin:0 1rem 1rem 0; }
.files-error, .root-error { color:var(--error, #dc2626); }
.files-error { border:1px solid currentColor; border-radius:6px; padding:.75rem; margin-bottom:1rem; }
.root-list { display:flex; flex-direction:column; gap:.75rem; }
.root-card { border:1px solid var(--border-default, #d5d9df); border-radius:8px; padding:1rem; background:var(--body-bg); }
.root-summary { justify-content:space-between; }
.root-name { display:flex; min-width:0; flex-direction:column; gap:.2rem; }
.root-path { color:var(--text-muted, var(--muted)); font-family:var(--font-mono, monospace); overflow:hidden; text-overflow:ellipsis; }
.root-state { white-space:nowrap; color:var(--text-muted, var(--muted)); }
.root-state.error, .root-error { color:var(--error, #dc2626); }
.root-meta { margin:.75rem 0; flex-wrap:wrap; color:var(--text-muted, var(--muted)); font-size:.85rem; }
.root-controls { flex-wrap:wrap; margin-bottom:.75rem; }
.root-controls label { display:flex; align-items:center; gap:.5rem; }
.root-controls .remove { margin-left:auto; }
.exclusions { display:flex; flex-direction:column; gap:.35rem; }
.exclusions small { color:var(--text-muted, var(--muted)); }
.exclusions textarea { resize:vertical; min-height:4rem; color:inherit; background:var(--body-bg); border:1px solid var(--border-default, #d5d9df); border-radius:6px; padding:.5rem; font-family:var(--font-mono, monospace); }
</style>
