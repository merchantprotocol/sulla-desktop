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
      <!-- Compose project groups -->
      <template v-for="group in groupedContainers" :key="group.project">
        <button
          v-if="group.project"
          class="compose-group-header"
          :class="{ dark: isDark }"
          @click="toggleGroup(group.project)"
        >
          <svg
            class="compose-chevron"
            :class="{ expanded: expandedGroups.has(group.project) }"
            width="10" height="10" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <svg class="compose-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="6" height="5" rx="1"/>
            <rect x="16" y="3" width="6" height="5" rx="1"/>
            <rect x="9" y="16" width="6" height="5" rx="1"/>
            <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
          </svg>
          <span class="compose-group-name">{{ group.project }}</span>
          <span class="compose-group-count" :class="{ dark: isDark }">{{ group.containers.length }}</span>
          <span
            class="compose-group-status"
            :class="groupRunningStatus(group.containers)"
          >{{ groupStatusLabel(group.containers) }}</span>
        </button>

        <template v-if="!group.project || expandedGroups.has(group.project)">
          <div
            v-for="c in group.containers"
            :key="c.id"
            class="container-item"
            :class="{ dark: isDark, expanded: expandedId === c.id, indented: !!group.project }"
            @click="toggleExpand(c.id)"
          >
            <div class="container-row">
              <span class="status-dot" :class="c.state === 'running' ? 'running' : 'stopped'"></span>
              <span class="container-name">{{ group.project ? stripProjectPrefix(c.name, group.project) : c.name }}</span>
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
        </template>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ipcRenderer } from 'electron';

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  composeProject: string;
}

interface ContainerGroup {
  project: string; // '' for standalone containers
  containers: DockerContainer[];
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
    const expandedGroups = ref(new Set<string>());
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const groupedContainers = computed<ContainerGroup[]>(() => {
      const projectMap = new Map<string, DockerContainer[]>();
      const standalone: DockerContainer[] = [];

      for (const c of containers.value) {
        if (c.composeProject) {
          if (!projectMap.has(c.composeProject)) {
            projectMap.set(c.composeProject, []);
          }
          projectMap.get(c.composeProject)!.push(c);
        } else {
          standalone.push(c);
        }
      }

      const groups: ContainerGroup[] = [];

      // Compose groups first, sorted by project name
      for (const [project, ctrs] of [...projectMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        groups.push({ project, containers: ctrs });
      }

      // Standalone containers at the end
      if (standalone.length > 0) {
        groups.push({ project: '', containers: standalone });
      }

      return groups;
    });

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

    function toggleGroup(project: string) {
      if (expandedGroups.value.has(project)) {
        expandedGroups.value.delete(project);
      } else {
        expandedGroups.value.add(project);
      }
    }

    function stripProjectPrefix(name: string, project: string): string {
      // Docker Compose names: "project-service-1" or "project_service_1"
      const prefixes = [`${project}-`, `${project}_`];
      for (const prefix of prefixes) {
        if (name.startsWith(prefix)) {
          // Strip trailing replica number too: "service-1" -> "service"
          return name.slice(prefix.length).replace(/-\d+$/, '');
        }
      }
      return name;
    }

    function groupRunningStatus(ctrs: DockerContainer[]): string {
      const running = ctrs.filter(c => c.state === 'running').length;
      if (running === ctrs.length) return 'all-running';
      if (running > 0) return 'partial';
      return 'all-stopped';
    }

    function groupStatusLabel(ctrs: DockerContainer[]): string {
      const running = ctrs.filter(c => c.state === 'running').length;
      if (running === ctrs.length) return 'running';
      if (running > 0) return `${running}/${ctrs.length}`;
      return 'stopped';
    }

    function parsedPorts(portsStr: string): ParsedPort[] {
      if (!portsStr) return [];
      const results: ParsedPort[] = [];
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
      expandedGroups,
      groupedContainers,
      refresh,
      toggleExpand,
      toggleGroup,
      stripProjectPrefix,
      groupRunningStatus,
      groupStatusLabel,
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
  font-size: var(--fs-code);
  background: var(--bg-surface);
}

.docker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  font-weight: var(--weight-semibold);
  font-size: var(--fs-body-sm);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-strong);
  flex-shrink: 0;
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
  background: var(--bg-hover);
}

.refresh-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.docker-status {
  padding: 16px 12px;
  color: var(--text-muted);
  font-size: var(--fs-code);
  text-align: center;
}

.docker-status.error {
  color: var(--text-error);
}

.container-list {
  overflow-y: auto;
  flex: 1;
}

/* Compose group header */
.compose-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  text-align: left;
  border-bottom: 1px solid var(--bg-surface-alt);
}

.compose-group-header:hover {
  background: var(--bg-hover);
}

.compose-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
  color: var(--text-muted);
}

.compose-chevron.expanded {
  transform: rotate(90deg);
}

.compose-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.compose-group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compose-group-count {
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  color: var(--text-muted);
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--bg-surface-alt);
}

.compose-group-status {
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

.compose-group-status.all-running {
  background: var(--bg-success);
  color: var(--status-success);
}

.compose-group-status.partial {
  background: var(--bg-warning);
  color: var(--status-warning);
}

.compose-group-status.all-stopped {
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
}

.container-item {
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--bg-surface-alt);
}

.container-item.indented {
  padding-left: 32px;
}

.container-item:hover {
  background: var(--bg-hover);
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
  background: var(--status-success);
}

.status-dot.stopped {
  background: var(--text-muted);
}

.container-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.container-details {
  margin-top: 6px;
  padding-left: 16px;
  font-size: var(--fs-body-sm);
}

.detail-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  align-items: flex-start;
}

.detail-label {
  color: var(--text-muted);
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
  color: var(--accent-primary, #0078d4);
  cursor: pointer;
  text-decoration: none;
}

.port-link:hover {
  text-decoration: underline;
}

.port-link.dark {
  color: var(--text-info);
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
  font-size: var(--fs-body-sm);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
}

.action-btn:hover {
  background: var(--bg-surface-hover);
}
</style>
