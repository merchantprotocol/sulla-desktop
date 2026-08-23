<template>
  <div class="kb-wrap">
    <aside class="kb-list">
      <div class="kb-search">
        <input
          v-model="query"
          placeholder="Search Knowledge Base"
          @input="loadNodes"
        >
      </div>
      <div
        v-if="loading"
        class="kb-state"
      >
        Loading…
      </div>
      <div
        v-else-if="error"
        class="kb-state error"
      >
        {{ error }}
      </div>
      <button
        v-for="node in nodes"
        :key="node.id"
        type="button"
        :class="{ active: node.id === selected?.id }"
        @click="selectNode(node)"
      >
        <b>{{ node.title }}</b><span>{{ node.node_type }} · {{ node.summary || 'No summary' }}</span>
      </button>
      <div
        v-if="!loading && !nodes.length"
        class="kb-state"
      >
        No Knowledge Base items found.
      </div>
    </aside>
    <section
      v-if="selected"
      class="kb-detail"
    >
      <div class="kb-type">
        {{ selected.node_type }}
      </div>
      <h2>{{ selected.title }}</h2>
      <p>{{ selected.summary }}</p>
      <div
        v-if="selected.detail"
        class="kb-detail-body"
      >
        {{ selected.detail }}
      </div>
      <h3>Related work</h3>
      <div
        v-if="workLoading"
        class="kb-state"
      >
        Loading related work…
      </div>
      <div
        v-else-if="!work.length"
        class="kb-state"
      >
        Nothing linked yet.
      </div>
      <article
        v-for="item in work"
        :key="item.id"
        class="kb-work"
      >
        <button
          type="button"
          @click="$emit('open-work', item)"
        >
          <span class="kb-crumb">{{ breadcrumb(item) }}</span><b>{{ item.item_title }}</b>
          <span>{{ item.relation_type }}<template v-if="item.note"> · {{ item.note }}</template></span>
          <small>{{ item.created_by || item.source || 'unknown source' }} · {{ item.item_status }}</small>
        </button>
        <button
          type="button"
          class="kb-unlink"
          @click="unlink(item)"
        >
          ×
        </button>
      </article>

      <div class="kb-attach">
        <h4>Attach work</h4>
        <select v-model="targetKey">
          <option value="">
            Choose a project, epic, or task…
          </option><option
            v-for="item in workOptions"
            :key="item.key"
            :value="item.key"
          >
            {{ item.label }}
          </option>
        </select>
        <select v-model="relation">
          <option
            v-for="value in RELATIONS"
            :key="value"
            :value="value"
          >
            {{ value }}
          </option>
        </select>
        <input
          v-model="note"
          placeholder="Optional note"
        >
        <button
          type="button"
          :disabled="!targetKey || saving"
          @click="attach"
        >
          {{ saving ? 'Attaching…' : 'Attach' }}
        </button>
      </div>
    </section>
    <section
      v-else
      class="kb-empty"
    >
      Choose a Knowledge Base item.
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { KnowledgeNodeRecord } from '@pkg/agent/database/models/KnowledgeGraphModel';
import type { LinkedWorkItemRecord, KnowledgeWorkItemKind } from '@pkg/agent/database/models/WorkItemKnowledgeModel';
import type { ProjectView } from '@pkg/composables/useProjects';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ projects: ProjectView[]; selectedNodeId?: string }>();
defineEmits<(event: 'open-work', item: LinkedWorkItemRecord) => void>();

const RELATIONS = ['related_to', 'context', 'resource', 'requirement', 'decision', 'evidence', 'lesson', 'deliverable'];
const query = ref(''); const loading = ref(false); const workLoading = ref(false); const saving = ref(false); const error = ref('');
const nodes = ref<KnowledgeNodeRecord[]>([]); const selected = ref<KnowledgeNodeRecord | null>(null); const work = ref<LinkedWorkItemRecord[]>([]);
const targetKey = ref(''); const relation = ref('related_to'); const note = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

const workOptions = computed(() => props.projects.flatMap(project => [
  { key: `project:${ project.id }`, label: `Project · ${ project.title }` },
  ...project.epics.flatMap(epic => [
    { key: `epic:${ epic.id }`, label: `Epic · ${ project.title } / ${ epic.title }` },
    ...epic.tasks.map(task => ({ key: `task:${ task.id }`, label: `Task · ${ project.title } / ${ epic.title } / ${ task.title }` })),
  ]),
]));

async function fetchNodes(): Promise<void> {
  loading.value = true; error.value = '';
  try {
    nodes.value = await ipcRenderer.invoke('knowledge:nodes-search', { query: query.value.trim(), limit: 100 });
    const requested = props.selectedNodeId && nodes.value.find(node => node.id === props.selectedNodeId);
    if (requested) await selectNode(requested);
    else if (!selected.value && nodes.value[0]) await selectNode(nodes.value[0]);
  } catch (err: any) { error.value = err?.message ?? String(err) } finally { loading.value = false }
}

function loadNodes(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(fetchNodes, 180);
}

async function selectNode(node: KnowledgeNodeRecord): Promise<void> {
  selected.value = node; workLoading.value = true;
  try { work.value = await ipcRenderer.invoke('knowledge:work-list', { knowledgeNodeId: node.id, limit: 200 }) } finally { workLoading.value = false }
}

function breadcrumb(item: LinkedWorkItemRecord): string {
  return [item.project_title, item.item_kind !== 'project' ? item.epic_title : null].filter(Boolean).join(' / ');
}

function parsedTarget(): { itemKind: KnowledgeWorkItemKind; itemId: string } | null {
  const [kind, id] = targetKey.value.split(':');
  return id ? { itemKind: kind as KnowledgeWorkItemKind, itemId: id } : null;
}

async function attach(): Promise<void> {
  const target = parsedTarget(); if (!target || !selected.value) return;
  saving.value = true;
  try {
    await ipcRenderer.invoke('work-items:knowledge-link', { ...target, knowledgeNodeId: selected.value.id, relationType: relation.value, note: note.value || null, source: 'ui', actor: 'human' });
    targetKey.value = ''; note.value = ''; await selectNode(selected.value);
  } finally { saving.value = false }
}

async function unlink(item: LinkedWorkItemRecord): Promise<void> {
  if (!selected.value) return;
  await ipcRenderer.invoke('work-items:knowledge-unlink', { itemKind: item.item_kind, itemId: item.item_id, knowledgeNodeId: selected.value.id, relationType: item.relation_type, source: 'ui', actor: 'human' });
  await selectNode(selected.value);
}

watch(() => props.selectedNodeId, (id) => { const node = nodes.value.find(candidate => candidate.id === id); if (node) selectNode(node); });
onMounted(fetchNodes);
</script>

<style scoped>
.kb-wrap { display: grid; grid-template-columns: minmax(240px, 32%) 1fr; min-height: 560px; border: 1px solid var(--pborder); border-radius: 12px; overflow: hidden; }
.kb-list { border-right: 1px solid var(--pborder); background: var(--psurf); overflow: auto; }
.kb-search { padding: 12px; position: sticky; top: 0; background: var(--psurf); }
.kb-search input, .kb-attach input, .kb-attach select { width: 100%; box-sizing: border-box; padding: 8px 10px; color: var(--ptext); background: var(--psurf2); border: 1px solid var(--pborder); border-radius: 7px; }
.kb-list > button { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 11px 13px; border: 0; border-top: 1px solid var(--pborder); color: var(--ptext); background: transparent; text-align: left; cursor: pointer; }
.kb-list > button.active { background: var(--accent-dim); }
.kb-list span, .kb-work span, .kb-work small, .kb-state { color: var(--ptext3); font-size: 12px; }
.kb-detail { padding: 22px; overflow: auto; }
.kb-type, .kb-crumb { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.kb-detail h2 { margin: 4px 0 8px; }.kb-detail h3 { margin-top: 28px; }.kb-detail-body { white-space: pre-wrap; color: var(--ptext2); }
.kb-work { display: flex; border-top: 1px solid var(--pborder); padding: 9px 0; }
.kb-work > button:first-child { flex: 1; display: flex; flex-direction: column; gap: 3px; border: 0; background: transparent; color: var(--ptext); text-align: left; cursor: pointer; }
.kb-unlink { border: 0; background: transparent; color: var(--danger); font-size: 19px; cursor: pointer; }
.kb-attach { display: grid; grid-template-columns: 1fr 150px 1fr auto; gap: 7px; margin-top: 22px; }.kb-attach h4 { grid-column: 1 / -1; margin: 0; }.kb-attach button { border: 0; border-radius: 7px; padding: 0 14px; background: var(--accent); color: white; }
.kb-empty { display: grid; place-items: center; color: var(--ptext3); }.error { color: var(--danger); }
@media (max-width: 800px) { .kb-wrap { grid-template-columns: 1fr; }.kb-list { max-height: 260px; border-right: 0; border-bottom: 1px solid var(--pborder); }.kb-attach { grid-template-columns: 1fr; } }
</style>
