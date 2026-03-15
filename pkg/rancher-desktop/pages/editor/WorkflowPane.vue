<template>
  <div
    class="workflow-pane"
    :class="{ dark: isDark }"
  >
    <!-- Tab bar -->
    <div
      class="workflow-tab-bar"
      :class="{ dark: isDark }"
    >
      <div class="workflow-tabs-scroll">
        <div
          v-for="tab in openTabs"
          :key="tab.id"
          class="workflow-tab"
          :class="{ active: tab.id === activeTabId, dark: isDark }"
          @click="activateTab(tab.id)"
        >
          <span class="workflow-tab-name">{{ tab.name }}</span>
          <button
            class="workflow-tab-close"
            :class="{ dark: isDark }"
            title="Close"
            @click.stop="closeTab(tab.id)"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line
                x1="18"
                y1="6"
                x2="6"
                y2="18"
              />
              <line
                x1="6"
                y1="6"
                x2="18"
                y2="18"
              />
            </svg>
          </button>
        </div>
      </div>
      <button
        class="workflow-tab-add"
        :class="{ active: showingPicker, dark: isDark }"
        title="Open or create workflow"
        @click="togglePicker"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
          />
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
          />
        </svg>
      </button>
      <button
        class="workflow-pane-close"
        :class="{ dark: isDark }"
        title="Close Panel"
        @click="$emit('close')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line
            x1="18"
            y1="6"
            x2="6"
            y2="18"
          />
          <line
            x1="6"
            y1="6"
            x2="18"
            y2="18"
          />
        </svg>
      </button>
    </div>

    <!-- Content area -->
    <div class="workflow-pane-content">
      <!-- Workflow picker (shown when "+" clicked or no tabs open) -->
      <div
        v-if="showingPicker || openTabs.length === 0"
        class="workflow-picker"
        :class="{ dark: isDark }"
      >
        <!-- Create new workflow card -->
        <div
          class="picker-card picker-card-create"
          :class="{ dark: isDark }"
          @click="createNewWorkflow"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line
              x1="12"
              y1="5"
              x2="12"
              y2="19"
            />
            <line
              x1="5"
              y1="12"
              x2="19"
              y2="12"
            />
          </svg>
          <span class="picker-card-text">Create New Workflow</span>
        </div>

        <!-- Existing workflows -->
        <div
          v-for="wf in availableWorkflows"
          :key="wf.id"
          class="picker-card"
          :class="{ dark: isDark }"
          @click="openWorkflow(wf.id, wf.name)"
          @contextmenu.prevent="showContextMenu($event, wf)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect
              x="2"
              y="3"
              width="6"
              height="5"
              rx="1"
            />
            <rect
              x="16"
              y="3"
              width="6"
              height="5"
              rx="1"
            />
            <rect
              x="9"
              y="16"
              width="6"
              height="5"
              rx="1"
            />
            <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
            <line
              x1="12"
              y1="12"
              x2="12"
              y2="16"
            />
          </svg>
          <div class="picker-card-info">
            <span class="picker-card-name">{{ wf.name }}</span>
            <span
              v-if="wf.updatedAt"
              class="picker-card-date"
            >{{ formatDate(wf.updatedAt) }}</span>
          </div>
        </div>

        <!-- Context menu -->
        <Teleport to="body">
          <div
            v-if="contextMenu.visible"
            class="wf-context-overlay"
            @click="hideContextMenu"
            @contextmenu.prevent="hideContextMenu"
          />
          <div
            v-if="contextMenu.visible"
            class="wf-context-menu"
            :class="{ dark: isDark }"
            :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
          >
            <button
              class="wf-context-item"
              :class="{ dark: isDark }"
              @click="renameWorkflow"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Rename
            </button>
            <button
              class="wf-context-item danger"
              :class="{ dark: isDark }"
              @click="deleteWorkflowFromMenu"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Delete
            </button>
          </div>
        </Teleport>

        <div
          v-if="availableWorkflows.length === 0"
          class="picker-empty"
        >
          <p class="picker-empty-text">
            No workflows saved yet
          </p>
        </div>
      </div>

      <!-- Node palette (shown when a tab is active and picker is closed) -->
      <WorkflowNodePalette
        v-else-if="activeTabId"
        :is-dark="isDark"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import WorkflowNodePalette from './workflow/WorkflowNodePalette.vue';
import { ipcRenderer } from 'electron';
import type { WorkflowListItem } from './workflow/types';

const props = defineProps<{
  isDark: boolean;
}>();

const emit = defineEmits<{
  close:                [];
  'workflow-activated': [workflowId: string];
  'workflow-closed':    [workflowId: string];
  'workflow-created':   [workflowId: string, workflowName: string];
  'workflow-deleted':   [workflowId: string];
}>();

interface OpenTab {
  id:   string;
  name: string;
}

const openTabs = ref<OpenTab[]>([]);
const activeTabId = ref<string | null>(null);
const showingPicker = ref(false);
const availableWorkflows = ref<WorkflowListItem[]>([]);
let nextNewId = 1;

const contextMenu = ref<{ visible: boolean; x: number; y: number; workflow: WorkflowListItem | null }>({
  visible: false, x: 0, y: 0, workflow: null,
});

onMounted(async() => {
  await loadWorkflowList();
});

async function loadWorkflowList() {
  try {
    availableWorkflows.value = await ipcRenderer.invoke('workflow-list');
  } catch {
    availableWorkflows.value = [];
  }
}

function activateTab(id: string) {
  activeTabId.value = id;
  showingPicker.value = false;
  emit('workflow-activated', id);
}

function closeTab(id: string) {
  const idx = openTabs.value.findIndex(t => t.id === id);
  if (idx === -1) return;

  openTabs.value.splice(idx, 1);
  emit('workflow-closed', id);

  if (activeTabId.value === id) {
    if (openTabs.value.length > 0) {
      const newActive = openTabs.value[Math.min(idx, openTabs.value.length - 1)];
      activateTab(newActive.id);
    } else {
      activeTabId.value = null;
    }
  }
}

function togglePicker() {
  showingPicker.value = !showingPicker.value;
  if (showingPicker.value) {
    loadWorkflowList();
  }
}

function openWorkflow(id: string, name: string) {
  // Don't open duplicate tabs
  const existing = openTabs.value.find(t => t.id === id);
  if (existing) {
    activateTab(existing.id);
    return;
  }

  openTabs.value.push({ id, name });
  activateTab(id);
}

async function createNewWorkflow() {
  const id = `workflow-${ Date.now() }`;
  const name = `Workflow ${ nextNewId++ }`;

  emit('workflow-created', id, name);
  openTabs.value.push({ id, name });
  activateTab(id);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function showContextMenu(event: MouseEvent, wf: WorkflowListItem) {
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, workflow: wf };
}

function hideContextMenu() {
  contextMenu.value = { visible: false, x: 0, y: 0, workflow: null };
}

function renameWorkflow() {
  const wf = contextMenu.value.workflow;
  hideContextMenu();
  if (!wf) return;

  // Open the workflow so the user can rename via settings
  openWorkflow(wf.id, wf.name);
  // Emit activated so AgentEditor loads it, then the user can use the gear to rename
}

async function deleteWorkflowFromMenu() {
  const wf = contextMenu.value.workflow;
  hideContextMenu();
  if (!wf) return;

  // Close the tab if it's open
  const tabIdx = openTabs.value.findIndex(t => t.id === wf.id);
  if (tabIdx !== -1) {
    closeTab(wf.id);
  }

  // Delete via IPC
  try {
    await ipcRenderer.invoke('workflow-delete', wf.id);
  } catch (err) {
    console.error('[WorkflowPane] Failed to delete workflow:', err);
  }

  emit('workflow-deleted', wf.id);
  await loadWorkflowList();
}

/**
 * Update the tab name when the workflow is renamed via settings.
 */
function updateTabName(workflowId: string, newName: string) {
  const tab = openTabs.value.find(t => t.id === workflowId);
  if (tab) tab.name = newName;

  const wf = availableWorkflows.value.find(w => w.id === workflowId);
  if (wf) wf.name = newName;
}

defineExpose({ updateTabName, loadWorkflowList, closeTab });
</script>

<style scoped>
.workflow-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--fs-code);
  user-select: none;
  overflow: hidden;
}

/* ── Tab bar ── */
.workflow-tab-bar {
  display: flex;
  align-items: center;
  height: 35px;
  flex-shrink: 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-strong);
  padding: 0 2px;
  gap: 1px;
}

.workflow-tabs-scroll {
  display: flex;
  align-items: center;
  flex: 1;
  overflow-x: auto;
  gap: 1px;
  min-width: 0;
}

.workflow-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.workflow-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.workflow-tab:hover {
  background: var(--bg-hover);
}

.workflow-tab.active {
  background: var(--bg-accent);
}

.workflow-tab-name {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workflow-tab.active .workflow-tab-name {
  color: var(--text-info);
}

.workflow-tab.dark .workflow-tab-name {
  color: var(--text-muted);
}

.workflow-tab.dark.active .workflow-tab-name {
  color: var(--text-info);
}

.workflow-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
  opacity: 0;
}

.workflow-tab:hover .workflow-tab-close {
  opacity: 1;
}

.workflow-tab-close:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.workflow-tab-add,
.workflow-pane-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.workflow-tab-add:hover,
.workflow-pane-close:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.workflow-tab-add.active {
  color: var(--text-info);
}

.workflow-tab-add.dark,
.workflow-pane-close.dark {
  color: var(--text-secondary);
}

.workflow-tab-add.dark:hover,
.workflow-pane-close.dark:hover {
  background: var(--bg-hover);
}

.workflow-tab-add.dark.active {
  color: var(--text-info);
}

/* ── Content ── */
.workflow-pane-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* ── Picker ── */
.workflow-picker {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  color: var(--text-secondary);
}

.picker-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-surface-alt);
}

.picker-card-create {
  border-style: dashed;
  color: var(--text-info);
}

.picker-card-text {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
}

.picker-card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.picker-card-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-card-date {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
}

.picker-card.dark .picker-card-date {
  color: var(--text-secondary);
}

.picker-empty {
  padding: 24px 16px;
  text-align: center;
}

.picker-empty-text {
  font-size: var(--fs-code);
  color: var(--text-muted);
  margin: 0;
}
</style>

<style>
/* Context menu styles — unscoped because they're teleported to body */
.wf-context-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9998;
}

.wf-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  padding: 4px;
  font-size: var(--fs-code);
}

.wf-context-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  font-size: var(--fs-code);
}

.wf-context-item:hover {
  background: var(--bg-surface-alt);
}

.wf-context-item.danger {
  color: var(--text-error);
}

.wf-context-item.danger:hover {
  background: var(--bg-error);
}
</style>
