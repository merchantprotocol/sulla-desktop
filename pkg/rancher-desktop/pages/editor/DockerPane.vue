<template>
  <div class="docker-pane" :class="{ dark: isDark }">
    <div class="docker-header" :class="{ dark: isDark }">
      <span class="docker-title">Docker</span>
      <div class="docker-header-actions">
        <button class="refresh-btn" :class="{ dark: isDark }" @click="refresh" :disabled="loading">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23,4 23,10 17,10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <button class="refresh-btn" :class="{ dark: isDark }" @click="$emit('close')" title="Close Panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading && containers.length === 0" class="docker-status">Loading...</div>
    <div v-else-if="error" class="docker-status error">{{ error }}</div>
    <div v-else-if="containers.length === 0" class="docker-status">No containers found</div>

    <div class="container-list" v-else>
      <div
        v-for="c in containers"
        :key="c.id"
        class="container-item"
        :class="{ dark: isDark, expanded: expandedId === c.id }"
        @click="toggleExpand(c.id)"
      >
        <div class="container-row">
          <span class="status-dot" :class="c.state === 'running' ? 'running' : 'stopped'"></span>
          <span class="container-name">{{ c.name }}</span>
        </div>

        <div v-if="expandedId === c.id" class="container-details">
          <div class="detail-row">
            <span class="detail-label">Image</span>
            <span class="detail-value">{{ c.image }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="detail-value">{{ c.status }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">ID</span>
            <span class="detail-value">{{ c.id }}</span>
          </div>
          <div v-if="parsedPorts(c.ports).length > 0" class="detail-row">
            <span class="detail-label">Ports</span>
            <div class="ports-list">
              <a
                v-for="port in parsedPorts(c.ports)"
                :key="port.url"
                class="port-link"
                :class="{ dark: isDark }"
                @click.stop="$emit('open-container-port', { url: port.url, name: c.name + ':' + port.hostPort })"
              >{{ port.hostPort }} &rarr; {{ port.containerPort }}</a>
            </div>
          </div>
          <div class="detail-actions">
            <button class="action-btn" :class="{ dark: isDark }" @click.stop="$emit('docker-logs', c.name)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14,2 14,8 20,8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              Logs
            </button>
            <button v-if="c.state === 'running'" class="action-btn" :class="{ dark: isDark }" @click.stop="$emit('docker-exec', c.name)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4,17 10,11 4,5"/>
                <line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
              Shell
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount } from 'vue';
import { ipcRenderer } from 'electron';

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
}

interface ParsedPort {
  hostPort: string;
  containerPort: string;
  url: string;
}

export default defineComponent({
  name: 'DockerPane',

  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['open-container-port', 'docker-logs', 'docker-exec', 'close'],

  setup() {
    const containers = ref<DockerContainer[]>([]);
    const loading = ref(false);
    const error = ref('');
    const expandedId = ref<string | null>(null);
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      loading.value = true;
      error.value = '';
      try {
        containers.value = await ipcRenderer.invoke('docker-list-containers');
      } catch (err: any) {
        error.value = err?.message || 'Failed to list containers';
      } finally {
        loading.value = false;
      }
    }

    function toggleExpand(id: string) {
      expandedId.value = expandedId.value === id ? null : id;
    }

    function parsedPorts(portsStr: string): ParsedPort[] {
      if (!portsStr) return [];
      const results: ParsedPort[] = [];
      // Docker ports format: "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
      const matches = portsStr.matchAll(/(?:(\d+\.\d+\.\d+\.\d+):)?(\d+)->(\d+)\/\w+/g);
      const seen = new Set<string>();
      for (const m of matches) {
        const hostPort = m[2];
        const containerPort = m[3];
        const key = `${hostPort}-${containerPort}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const HTTPS_PORTS = new Set(['443', '8443', '9443']);
        const protocol = HTTPS_PORTS.has(hostPort) || HTTPS_PORTS.has(containerPort) ? 'https' : 'http';
        results.push({
          hostPort,
          containerPort,
          url: `${protocol}://localhost:${hostPort}`,
        });
      }
      return results;
    }

    onMounted(() => {
      refresh();
      refreshTimer = setInterval(refresh, 10000);
    });

    onBeforeUnmount(() => {
      if (refreshTimer) clearInterval(refreshTimer);
    });

    return {
      containers,
      loading,
      error,
      expandedId,
      refresh,
      toggleExpand,
      parsedPorts,
    };
  },
});
</script>

<style scoped>
.docker-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 13px;
  background: #f8fafc;
}

.docker-pane.dark {
  background: #1e293b;
}

.docker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.docker-header.dark {
  color: #94a3b8;
  background: #1e293b;
  border-bottom-color: #334155;
}

.docker-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.refresh-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.refresh-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.refresh-btn.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.refresh-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.docker-status {
  padding: 16px 12px;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
}

.docker-status.error {
  color: #ef4444;
}

.container-list {
  overflow-y: auto;
  flex: 1;
}

.container-item {
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 1px solid #f1f5f9;
}

.container-item:hover {
  background: rgba(0, 0, 0, 0.03);
}

.container-item.dark {
  border-bottom-color: #1e293b;
}

.container-item.dark:hover {
  background: rgba(255, 255, 255, 0.03);
}

.container-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.running {
  background: #22c55e;
}

.status-dot.stopped {
  background: #94a3b8;
}

.container-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.container-details {
  margin-top: 6px;
  padding-left: 16px;
  font-size: 11px;
}

.detail-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  align-items: flex-start;
}

.detail-label {
  color: #94a3b8;
  min-width: 42px;
  flex-shrink: 0;
}

.detail-value {
  word-break: break-all;
}

.ports-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.port-link {
  color: #0078d4;
  cursor: pointer;
  text-decoration: none;
}

.port-link:hover {
  text-decoration: underline;
}

.port-link.dark {
  color: #60a5fa;
}

.detail-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #f8fafc;
  color: #334155;
  cursor: pointer;
}

.action-btn:hover {
  background: #e2e8f0;
}

.action-btn.dark {
  border-color: #475569;
  background: #334155;
  color: #e2e8f0;
}

.action-btn.dark:hover {
  background: #475569;
}
</style>
