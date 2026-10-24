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
interface FileProviderView { supported:boolean; enabled:boolean; running:boolean; helperPresent:boolean; registered?:boolean; error?:string }
interface BackupDestination { id:string; kind:'local'|'nas'|'s3'; label:string; status?:{state:'running'|'verified'|'failed';finished_at?:string;error_message?:string} }

export default defineComponent({
  name: 'preferences-body-files',
  data() {
    return { roots: [] as FileRootView[], backups:[] as BackupDestination[], backupKind:'local' as 'local'|'nas'|'s3', backupLabel:'', backupSubfolder:'', backupEndpoint:'', backupShare:'', backupProtocol:'smb' as 'smb'|'nfs', backupBucket:'', backupRegion:'', backupCredentialId:'', backupPoll:undefined as ReturnType<typeof setInterval>|undefined, rootPoll:undefined as ReturnType<typeof setInterval>|undefined, fileProvider:undefined as FileProviderView|undefined, fileProviderSaving:false, loading: true, error: '', saving: new Set<string>() };
  },
  async mounted() {
    await this.load();
    void this.loadFileProvider();
    this.rootPoll=setInterval(()=>{ if(this.roots.some(root=>root.state==='scanning'||root.state==='syncing')) void this.loadRoots() },1_000);
    this.backupPoll=setInterval(()=>{
      if(this.backups.some(destination=>destination.status?.state==='running')) void this.loadBackups();
    },3_000);
  },
  beforeUnmount() { if(this.backupPoll) clearInterval(this.backupPoll); if(this.rootPoll) clearInterval(this.rootPoll) },
  methods: {
    async loadFileProvider() {
      try { this.fileProvider=await ipcRenderer.invoke('files-preferences:file-provider-status') } catch(error) { this.error=error instanceof Error?error.message:String(error) }
    },
    async setFileProvider(enabled:boolean) {
      this.fileProviderSaving=true; this.error='';
      try { this.fileProvider=await ipcRenderer.invoke('files-preferences:set-file-provider',{enabled}) } catch(error) { this.error=error instanceof Error?error.message:String(error) } finally { this.fileProviderSaving=false }
    },
    async loadRoots() {
      try { this.roots=await ipcRenderer.invoke('files-preferences:list-roots') } catch(error) { this.error=error instanceof Error?error.message:String(error) }
    },
    async loadBackups() {
      try { this.backups=(await ipcRenderer.invoke('files-backups:list')).destinations as BackupDestination[] } catch(error) {this.error=error instanceof Error?error.message:String(error)}
    },
    async removeBackup(destination:BackupDestination) {
      this.saving.add(destination.id);
      try {await ipcRenderer.invoke('files-backups:remove',destination.id);await this.loadBackups()} catch(error) {this.error=error instanceof Error?error.message:String(error)} finally {this.saving.delete(destination.id)}
    },
    async load() {
      this.loading = true; this.error = '';
      try { this.roots = await ipcRenderer.invoke('files-preferences:list-roots'); this.backups=(await ipcRenderer.invoke('files-backups:list')).destinations as BackupDestination[] } catch (error) { this.error = error instanceof Error ? error.message : String(error) } finally { this.loading = false }
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
    async addBackup(){
      const config=this.backupKind==='local' ? {kind:'local',root:`/var/lib/sulla-files-backups/${ this.backupSubfolder }`} : this.backupKind==='nas'
        ? {kind:'nas',share:this.backupShare,protocol:this.backupProtocol,vaultCredentialId:this.backupCredentialId||undefined}
        : {kind:'s3',endpoint:this.backupEndpoint,bucket:this.backupBucket,region:this.backupRegion||undefined,vaultCredentialId:this.backupCredentialId};
      try {await ipcRenderer.invoke('files-backups:add',{kind:this.backupKind,label:this.backupLabel,config}); await this.load()} catch(error) {this.error=error instanceof Error?error.message:String(error)}
    },
    async runBackup(destination:BackupDestination){ this.saving.add(destination.id); try { await ipcRenderer.invoke('files-backups:run',destination.id); await this.load() } catch(error){this.error=error instanceof Error?error.message:String(error)} finally {this.saving.delete(destination.id)} },
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
    <div v-if="fileProvider?.supported" class="files-heading backup-heading">
      <div>
        <h3>Finder location</h3>
        <p class="description">Shows Sulla Files in Finder under Locations (~/Library/CloudStorage). Your Documents folder isn't moved. Only you can turn this on.</p>
        <p v-if="fileProvider.enabled && fileProvider.registered === false" class="description">Approve Sulla in System Settings → General → Login Items &amp; Extensions → File Provider.</p>
        <p v-if="fileProvider.error" class="root-error">{{ fileProvider.error }}</p>
      </div>
      <button class="btn role-secondary" :disabled="fileProviderSaving || !fileProvider.helperPresent" @click="setFileProvider(!fileProvider.enabled)">{{ fileProvider.enabled ? 'Turn off' : 'Turn on' }}</button>
    </div>
    <div class="files-heading backup-heading"><div><h3>Backups</h3><p class="description">Hourly for 24 hours, daily for 30 days, and weekly for 12 weeks. Snapshots are verified before older copies are pruned.</p></div></div>
    <div class="root-controls backup-add">
      <label>Destination <select v-model="backupKind"><option value="local">This computer (Sulla VM disk)</option><option value="nas">NAS (SMB/NFS)</option><option value="s3">S3-compatible</option></select></label>
      <input v-model="backupLabel" placeholder="Name"><input v-if="backupKind === 'local'" v-model="backupSubfolder" placeholder="Subfolder name"><input v-if="backupKind === 'nas'" v-model="backupShare" placeholder="Share URL"><select v-if="backupKind === 'nas'" v-model="backupProtocol"><option value="smb">SMB</option><option value="nfs">NFS</option></select><input v-if="backupKind === 's3'" v-model="backupEndpoint" placeholder="HTTPS endpoint"><input v-if="backupKind === 's3'" v-model="backupBucket" placeholder="Bucket"><input v-if="backupKind === 's3'" v-model="backupRegion" placeholder="Signing region (default us-east-1)"><input v-if="backupKind !== 'local'" v-model="backupCredentialId" placeholder="Vault credential ID">
      <button class="btn role-primary" @click="addBackup">Add destination</button>
    </div>
    <p v-if="backupKind === 'local'" class="description">This copy protects against mistakes, not disk loss: it lives on this computer's Sulla VM disk.</p>
    <p v-if="backupKind !== 'local'" class="description">Use a personal Vault item with backup_kind (nas or s3) and backup_target matching the exact share URL or HTTPS endpoint. SMB needs username/password; S3 needs accessKeyId/secretAccessKey (optional sessionToken).</p>
    <div class="root-list">
      <section v-for="destination in backups" :key="destination.id" class="root-card">
        <div class="root-summary"><div class="root-name"><strong>{{ destination.label }}</strong><span class="root-path">{{ destination.kind.toUpperCase() }}</span></div><span class="root-state" :class="destination.status?.state">{{ destination.status?.state ?? 'Not run' }}</span></div>
        <div class="root-meta"><span>Last success: {{ destination.status?.state === 'verified' ? time(destination.status.finished_at) : 'Not yet' }}</span><span>Last verified restore: {{ destination.status?.state === 'verified' ? time(destination.status.finished_at) : 'Not yet' }}</span></div>
        <p v-if="destination.status?.error_message" class="root-error">{{ destination.status.error_message }}</p>
        <div class="root-controls"><button class="btn role-secondary" :disabled="saving.has(destination.id) || destination.status?.state === 'running'" @click="runBackup(destination)">Run now</button><button class="btn role-secondary" disabled title="Restore requires an empty Files destination">Restore…</button><button class="btn role-secondary" :disabled="saving.has(destination.id) || destination.status?.state === 'running'" title="Removes configuration only; backup data is kept" @click="removeBackup(destination)">Remove</button></div>
      </section>
      <div v-if="!backups.length" class="files-empty">No personal backup destination configured.</div>
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
.backup-heading { margin-top:2rem; }
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
