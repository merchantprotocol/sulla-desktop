<template>
  <div class="usage" data-testid="usage-page">
    <div class="usage-header">
      <h1>Docker usage</h1>
      <button class="btn role-secondary" data-testid="usage-refresh" :disabled="loading || pruning" @click="refresh">
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="usage-error" data-testid="usage-error">{{ error }}</div>
    <div v-if="resultSummary" class="usage-result" data-testid="usage-result">{{ resultSummary }}</div>

    <div v-if="loading && !usage" class="usage-muted">Loading Docker usage…</div>

    <template v-if="usage">
      <div class="usage-cards">
        <div class="usage-card">
          <div class="usage-card-title">Running containers</div>
          <div class="usage-card-value">{{ fmt(usage.running.sizeBytes) }}</div>
          <div class="usage-muted">{{ usage.running.count }} containers</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-title">Stopped containers</div>
          <div class="usage-card-value">{{ fmt(usage.stopped.sizeBytes) }}</div>
          <div class="usage-muted">{{ usage.stopped.count }} containers</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-title">Unused volumes</div>
          <div class="usage-card-value">{{ fmt(usage.volumes.unusedSizeBytes) }}</div>
          <div class="usage-muted">{{ usage.volumes.unusedCount }} of {{ usage.volumes.count }} volumes</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-title">Images</div>
          <div class="usage-card-value">{{ fmt(usage.images.sizeBytes) }}</div>
          <div class="usage-muted">{{ usage.images.count }} images</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-title">Build cache</div>
          <div class="usage-card-value">{{ fmt(usage.buildCache.sizeBytes) }}</div>
          <div class="usage-muted">{{ usage.buildCache.count }} entries</div>
        </div>
        <div class="usage-card usage-card-accent">
          <div class="usage-card-title">Reclaimable</div>
          <div class="usage-card-value">{{ fmt(usage.reclaimableTotal) }}</div>
          <div class="usage-muted">if everything is pruned</div>
        </div>
      </div>

      <h2>Prune</h2>
      <div class="usage-options">
        <label class="usage-option">
          <input v-model="opts.containers" type="checkbox" :disabled="pruning" data-testid="opt-containers">
          <span>Stopped containers <b>{{ fmt(usage.stopped.reclaimableBytes) }}</b></span>
          <small v-if="usage.stopped.protectedCount" class="usage-muted">{{ usage.stopped.protectedCount }} protected (Sulla)</small>
        </label>
        <label class="usage-option">
          <input v-model="opts.images" type="checkbox" :disabled="pruning" data-testid="opt-images">
          <span>Unused images <b>{{ fmt(usage.images.reclaimableBytes) }}</b></span>
        </label>
        <label v-if="opts.images" class="usage-option usage-sub">
          <input v-model="opts.allImages" type="checkbox" :disabled="pruning">
          <span>Include all unused images, not just dangling ones</span>
        </label>
        <label class="usage-option">
          <input v-model="opts.buildCache" type="checkbox" :disabled="pruning" data-testid="opt-cache">
          <span>Build cache <b>{{ fmt(usage.buildCache.reclaimableBytes) }}</b></span>
        </label>
        <label class="usage-option usage-danger">
          <input v-model="opts.volumes" type="checkbox" :disabled="pruning" data-testid="opt-volumes">
          <span>Unused volumes <b>{{ fmt(usage.volumes.reclaimableBytes) }}</b></span>
          <small v-if="usage.volumes.protectedCount" class="usage-muted">{{ usage.volumes.protectedCount }} protected (Sulla)</small>
        </label>
        <div v-if="opts.volumes" class="usage-warning">
          Warning: this permanently deletes volume data. Volumes to be removed:
          <ul>
            <li v-for="v in volumesToRemove" :key="v.name">{{ v.name }} ({{ fmt(v.sizeBytes) }})</li>
            <li v-if="!volumesToRemove.length" class="usage-muted">none</li>
          </ul>
        </div>
      </div>

      <div v-if="protectedItems.length" class="usage-muted usage-protected">
        Protected (Sulla), never removed: {{ protectedItems.join(', ') }}
      </div>

      <div class="usage-actions">
        <button
          class="btn role-primary"
          data-testid="usage-prune"
          :disabled="pruning || loading || !anySelected"
          @click="confirming = true"
        >
          {{ pruning ? 'Pruning…' : 'Prune selected' }}
        </button>
        <span v-if="pruning" class="usage-muted">Pruning Docker, this can take a minute…</span>
      </div>
    </template>

    <div v-if="confirming && usage" class="usage-overlay" @click.self="confirming = false">
      <div class="usage-dialog" role="dialog" aria-modal="true">
        <h3>Confirm prune</h3>
        <p>This will remove:</p>
        <ul>
          <li v-if="opts.containers">{{ containersToRemove.length }} stopped containers ({{ fmt(usage.stopped.reclaimableBytes) }}): {{ containersToRemove.map(c => c.name).join(', ') || 'none' }}</li>
          <li v-if="opts.images">{{ opts.allImages ? 'All unused images' : 'Dangling images' }} (up to {{ fmt(usage.images.reclaimableBytes) }})</li>
          <li v-if="opts.buildCache">Build cache ({{ fmt(usage.buildCache.reclaimableBytes) }})</li>
          <li v-if="opts.volumes" class="usage-danger-text">{{ volumesToRemove.length }} unused volumes, data deleted permanently ({{ fmt(usage.volumes.reclaimableBytes) }}): {{ volumesToRemove.map(v => v.name).join(', ') || 'none' }}</li>
        </ul>
        <p>Estimated space reclaimed: <b>{{ fmt(selectedBytes) }}</b>. Running containers, in-use volumes and Sulla resources are never touched.</p>
        <div class="usage-actions">
          <button class="btn role-secondary" @click="confirming = false">Cancel</button>
          <button class="btn role-primary" data-testid="usage-confirm" @click="prune">Prune now</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

import type { DockerUsage, PruneResult } from '@pkg/utils/dockerUsage';
import { formatBytes, getDockerUsage, pruneDocker } from '@pkg/utils/dockerUsage';

export default defineComponent({
  name: 'DockerUsage',
  data() {
    return {
      usage:         null as DockerUsage | null,
      loading:       false,
      pruning:       false,
      confirming:    false,
      error:         '' as string,
      resultSummary: '' as string,
      opts:          {
        containers: true, images: true, allImages: false, buildCache: true, volumes: false,
      },
    };
  },
  computed: {
    containersToRemove(): { name: string; sizeBytes: number }[] {
      return (this.usage?.stopped.items ?? []).filter(i => !i.protected);
    },
    volumesToRemove(): { name: string; sizeBytes: number }[] {
      return (this.usage?.volumes.items ?? []).filter(i => !i.protected);
    },
    protectedItems(): string[] {
      const u = this.usage;

      return u ? [...u.stopped.items, ...u.volumes.items].filter(i => i.protected).map(i => i.name) : [];
    },
    anySelected(): boolean {
      const o = this.opts;

      return o.containers || o.images || o.buildCache || o.volumes;
    },
    selectedBytes(): number {
      const u = this.usage;

      if (!u) {
        return 0;
      }

      return (this.opts.containers ? u.stopped.reclaimableBytes : 0) +
        (this.opts.images ? u.images.reclaimableBytes : 0) +
        (this.opts.buildCache ? u.buildCache.reclaimableBytes : 0) +
        (this.opts.volumes ? u.volumes.reclaimableBytes : 0);
    },
  },
  mounted() {
    this.refresh();
  },
  methods: {
    fmt(bytes: number) {
      return formatBytes(bytes);
    },
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.usage = await getDockerUsage();
      } catch (ex: any) {
        this.error = `Failed to read Docker usage: ${ ex?.message || ex }`;
      } finally {
        this.loading = false;
      }
    },
    async prune() {
      this.confirming = false;
      this.pruning = true;
      this.error = '';
      this.resultSummary = '';
      try {
        const r: PruneResult = await pruneDocker({ ...this.opts });

        this.resultSummary = `Reclaimed ${ formatBytes(r.bytesReclaimed) } (${ r.containers.removed.length } containers, ${ r.volumes.removed.length } volumes removed).`;
        if (r.errors.length) {
          this.error = r.errors.join('\n');
        }
      } catch (ex: any) {
        this.error = `Prune failed: ${ ex?.message || ex }`;
      } finally {
        this.pruning = false;
      }
      await this.refresh();
    },
  },
});
</script>

<style lang="scss" scoped>
.usage { padding: 16px; display: flex; flex-direction: column; gap: 14px; color: var(--text); }
.usage-header { display: flex; justify-content: space-between; align-items: center; }
.usage-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.usage-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.usage-card-accent { border-color: var(--accent-border); }
.usage-card-title { color: var(--text-muted); font-size: 12px; text-transform: uppercase; }
.usage-card-value { font-size: 22px; font-weight: 600; margin: 4px 0; }
.usage-muted { color: var(--text-muted); font-size: 12px; }
.usage-options { display: flex; flex-direction: column; gap: 8px; }
.usage-option { display: flex; gap: 8px; align-items: center; }
.usage-sub { margin-left: 24px; }
.usage-warning, .usage-error { background: var(--surface-2); border: 1px solid var(--warning); border-radius: 6px; padding: 10px; white-space: pre-wrap; }
.usage-error { border-color: var(--danger); }
.usage-result { background: var(--surface-2); border: 1px solid var(--success); border-radius: 6px; padding: 10px; }
.usage-danger-text { color: var(--danger); }
.usage-actions { display: flex; gap: 12px; align-items: center; }
.usage-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.usage-dialog { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 20px; max-width: 560px; max-height: 80vh; overflow: auto; }
</style>
