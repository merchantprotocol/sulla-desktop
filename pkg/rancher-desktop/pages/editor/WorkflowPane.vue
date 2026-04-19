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
          v-for="(tab, index) in openTabs"
          :key="tab.id"
          class="workflow-tab"
          :class="{
            active: tab.id === activeTabId,
            dark: isDark,
            'drag-over-left': dragOverIndex === index && dragDirection === 'left',
            'drag-over-right': dragOverIndex === index && dragDirection === 'right',
            dragging: dragIndex === index,
          }"
          draggable="true"
          @click="activateTab(tab.id)"
          @dragstart="onDragStart($event, index)"
          @dragover.prevent="onDragOver($event, index)"
          @dragend="onDragEnd"
          @drop.prevent="onDrop(index)"
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
        class="workflow-tab-refresh"
        :class="{ dark: isDark, spinning: refreshing }"
        title="Refresh workflow list from disk"
        @click="refreshFromDisk"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
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
        <!-- Search filter -->
        <input
          v-model="searchFilter"
          class="wf-search-input"
          :class="{ dark: isDark }"
          type="text"
          placeholder="Filter workflows..."
        >

        <!-- Create new workflow -->
        <button
          class="wf-create-btn"
          :class="{ dark: isDark }"
          @click="createNewWorkflow"
        >
          <svg
            width="12"
            height="12"
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
          New Workflow
        </button>

        <!-- Grouped tree view -->
        <div
          v-for="group in groups"
          :key="group.key"
          class="wf-group"
        >
          <div
            class="wf-group-header"
            :class="{ dark: isDark }"
            @click="toggleGroup(group.key)"
          >
            <svg
              class="wf-group-chevron"
              :class="{ expanded: expandedGroups.has(group.key) }"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span
              class="wf-group-dot"
              :class="group.key"
            />
            <span class="wf-group-label">{{ group.label }}</span>
            <span class="wf-group-count">{{ group.workflows.length }}</span>
          </div>
          <div
            v-if="expandedGroups.has(group.key)"
            class="wf-group-items"
          >
            <div
              v-for="wf in group.workflows"
              :key="wf.id"
              class="wf-list-item"
              :class="{ dark: isDark }"
              @click="openWorkflow(wf.id, wf.name)"
              @contextmenu.prevent="showContextMenu($event, wf)"
            >
              <svg
                width="12"
                height="12"
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
              <span class="wf-list-item-name">{{ wf.name }}</span>
            </div>
            <div
              v-if="group.workflows.length === 0"
              class="wf-group-empty"
            >
              No workflows
            </div>
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
              v-if="contextMenu.workflow?.status !== 'production'"
              class="wf-context-item"
              :class="{ dark: isDark }"
              @click="moveWorkflowFromMenu('production')"
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
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line
                  x1="12"
                  y1="2"
                  x2="12"
                  y2="12"
                />
              </svg>
              Move to Production
            </button>
            <button
              v-if="contextMenu.workflow?.status !== 'draft'"
              class="wf-context-item"
              :class="{ dark: isDark }"
              @click="moveWorkflowFromMenu('draft')"
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
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Move to Draft
            </button>
            <button
              v-if="contextMenu.workflow?.status !== 'archive'"
              class="wf-context-item"
              :class="{ dark: isDark }"
              @click="moveWorkflowFromMenu('archive')"
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
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect
                  x="1"
                  y="3"
                  width="22"
                  height="5"
                />
                <line
                  x1="10"
                  y1="12"
                  x2="14"
                  y2="12"
                />
              </svg>
              Archive
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
import { ipcRenderer } from 'electron';
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';

import WorkflowNodePalette from './workflow/WorkflowNodePalette.vue';

import type { WorkflowListItem, WorkflowStatus } from './workflow/types';

const props = defineProps<{
  isDark: boolean;
}>();

const emit = defineEmits<{
  close:                     [];
  'workflow-activated':      [workflowId: string];
  'workflow-closed':         [workflowId: string];
  'workflow-created':        [workflowId: string, workflowName: string];
  'workflow-deleted':        [workflowId: string];
  'workflow-moved':          [workflowId: string, newStatus: WorkflowStatus];
  'workflow-list-refreshed': [];
  'workflow-files-changed':  [];
}>();

interface OpenTab {
  id:   string;
  name: string;
}

const openTabs = ref<OpenTab[]>([]);
const activeTabId = ref<string | null>(null);
const showingPicker = ref(false);
const availableWorkflows = ref<WorkflowListItem[]>([]);
const searchFilter = ref('');
const expandedGroups = ref(new Set<string>(['production', 'draft']));
const refreshing = ref(false);
let nextNewId = 1;

// Drag-and-drop state
const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);
const dragDirection = ref<'left' | 'right' | null>(null);

function onDragStart(event: DragEvent, index: number) {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(event: DragEvent, index: number) {
  if (dragIndex.value === null || dragIndex.value === index) {
    dragOverIndex.value = null;
    dragDirection.value = null;

    return;
  }
  dragOverIndex.value = index;
  dragDirection.value = index < dragIndex.value ? 'left' : 'right';
}

function onDrop(targetIndex: number) {
  if (dragIndex.value === null || dragIndex.value === targetIndex) {
    onDragEnd();

    return;
  }
  const [moved] = openTabs.value.splice(dragIndex.value, 1);

  openTabs.value.splice(targetIndex, 0, moved);
  onDragEnd();
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
  dragDirection.value = null;
}

const contextMenu = ref<{ visible: boolean; x: number; y: number; workflow: WorkflowListItem | null }>({
  visible: false, x: 0, y: 0, workflow: null,
});

// Computed: filtered and grouped workflows
const filteredWorkflows = computed(() => {
  const q = searchFilter.value.trim().toLowerCase();
  if (!q) return availableWorkflows.value;
  return availableWorkflows.value.filter(wf => wf.name.toLowerCase().includes(q));
});

const groups = computed(() => {
  const statusGroups: { key: WorkflowStatus; label: string }[] = [
    { key: 'production', label: 'Production' },
    { key: 'draft', label: 'Draft' },
    { key: 'archive', label: 'Archive' },
  ];

  return statusGroups.map(g => ({
    ...g,
    workflows: filteredWorkflows.value.filter(wf => wf.status === g.key),
  }));
});

async function refreshFromDisk() {
  refreshing.value = true;
  await loadWorkflowList();
  emit('workflow-list-refreshed');
  setTimeout(() => {
    refreshing.value = false;
  }, 600);
}

function onFilesChanged() {
  loadWorkflowList();
  emit('workflow-files-changed');
}

onMounted(async() => {
  await loadWorkflowList();
  ipcRenderer.invoke('workflow-watch-start').catch(() => {});
  ipcRenderer.on('workflow-files-changed', onFilesChanged);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('workflow-files-changed', onFilesChanged);
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

function toggleGroup(key: string) {
  if (expandedGroups.value.has(key)) {
    expandedGroups.value.delete(key);
  } else {
    expandedGroups.value.add(key);
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
}

async function moveWorkflowFromMenu(targetStatus: WorkflowStatus) {
  const wf = contextMenu.value.workflow;
  hideContextMenu();
  if (!wf) return;

  try {
    await ipcRenderer.invoke('workflow-move', wf.id, targetStatus);
    emit('workflow-moved', wf.id, targetStatus);
    await loadWorkflowList();
  } catch (err) {
    console.error('[WorkflowPane] Failed to move workflow:', err);
  }
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

.workflow-tab.dragging {
  opacity: 0.4;
}

.workflow-tab.drag-over-left {
  box-shadow: -2px 0 0 0 var(--text-info);
}

.workflow-tab.drag-over-right {
  box-shadow: 2px 0 0 0 var(--text-info);
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
.workflow-tab-refresh,
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
.workflow-tab-refresh:hover,
.workflow-pane-close:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.workflow-tab-add.active {
  color: var(--text-info);
}

.workflow-tab-refresh.spinning svg {
  animation: spin 0.6s ease-in-out;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.workflow-tab-add.dark,
.workflow-tab-refresh.dark,
.workflow-pane-close.dark {
  color: var(--text-secondary);
}

.workflow-tab-add.dark:hover,
.workflow-tab-refresh.dark:hover,
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
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Search ── */
.wf-search-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface-alt);
  color: var(--text-primary);
  font-size: var(--fs-body-sm);
  font-family: inherit;
  outline: none;
  margin-bottom: 4px;
  box-sizing: border-box;
}

.wf-search-input::placeholder {
  color: var(--text-muted);
}

.wf-search-input:focus {
  border-color: var(--border-strong);
}

/* ── Create button ── */
.wf-create-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px dashed var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-info);
  font-size: var(--fs-body-sm);
  font-family: inherit;
  cursor: pointer;
  margin-bottom: 4px;
}

.wf-create-btn:hover {
  border-color: var(--text-info);
  background: var(--bg-hover);
}

/* ── Group ── */
.wf-group {
  margin-bottom: 2px;
}

.wf-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.wf-group-header:hover {
  background: var(--bg-hover);
}

.wf-group-chevron {
  flex-shrink: 0;
  transition: transform 0.15s;
}

.wf-group-chevron.expanded {
  transform: rotate(90deg);
}

.wf-group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.wf-group-dot.production {
  background: var(--status-success);
}

.wf-group-dot.draft {
  background: var(--status-warning);
}

.wf-group-dot.archive {
  background: var(--text-muted);
}

.wf-group-label {
  flex: 1;
}

.wf-group-count {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

/* ── List items ── */
.wf-group-items {
  padding-left: 8px;
}

.wf-list-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
}

.wf-list-item:hover {
  background: var(--bg-hover);
}

.wf-list-item svg {
  flex-shrink: 0;
  color: var(--text-muted);
}

.wf-list-item-name {
  font-size: var(--fs-body-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.wf-group-empty {
  padding: 4px 8px;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  font-style: italic;
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
  min-width: 160px;
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
