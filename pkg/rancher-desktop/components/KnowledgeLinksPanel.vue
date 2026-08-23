<template>
  <section class="knowledge-links">
    <button
      type="button"
      class="kl-head"
      @click="toggle"
    >
      <span>Knowledge</span><span class="kl-count">{{ loading ? '…' : (expanded ? links.length : '') }} {{ expanded ? '▴' : '▾' }}</span>
    </button>
    <div
      v-if="expanded"
      class="kl-body"
    >
      <div
        v-if="error"
        class="kl-error"
      >
        {{ error }} <button
          type="button"
          @click="load"
        >
          Retry
        </button>
      </div>
      <div
        v-else-if="loading"
        class="kl-muted"
      >
        Loading associations…
      </div>
      <div
        v-else-if="!links.length"
        class="kl-muted"
      >
        No linked knowledge yet.
      </div>
      <article
        v-for="link in links"
        :key="`${link.id}:${link.scope}`"
        class="kl-row"
      >
        <button
          type="button"
          class="kl-main"
          @click="$emit('open-node', link.node_id)"
        >
          <span class="kl-title">{{ link.title }}</span>
          <span class="kl-meta">
            <b>{{ link.relation_type }}</b>
            <em :class="link.scope">{{ link.scope }}</em>
            <span v-if="link.scope === 'inherited'">from {{ link.linked_item_kind }} {{ link.linked_item_title }}</span>
          </span>
          <span
            v-if="link.note"
            class="kl-note"
          >{{ link.note }}</span>
        </button>
        <button
          v-if="link.scope === 'direct'"
          type="button"
          class="kl-remove"
          title="Remove direct link"
          @click="unlink(link)"
        >
          ×
        </button>
      </article>

      <div class="kl-attach">
        <input
          v-model="query"
          placeholder="Search existing knowledge…"
          @input="search"
        >
        <div
          v-if="searching"
          class="kl-muted"
        >
          Searching…
        </div>
        <button
          v-for="node in results"
          :key="node.id"
          type="button"
          class="kl-result"
          @click="chosen = node"
        >
          <b>{{ node.title }}</b><span>{{ node.summary }}</span>
        </button>
        <template v-if="chosen">
          <div class="kl-chosen">
            Attach <b>{{ chosen.title }}</b>
          </div>
          <div class="kl-fields">
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
              :disabled="saving"
              @click="attach"
            >
              {{ saving ? 'Attaching…' : 'Attach' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import type { KnowledgeNodeRecord } from '@pkg/agent/database/models/KnowledgeGraphModel';
import type { KnowledgeWorkItemKind, LinkedKnowledgeRecord } from '@pkg/agent/database/models/WorkItemKnowledgeModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ itemKind: KnowledgeWorkItemKind; itemId: string }>();
defineEmits<(event: 'open-node', id: string) => void>();

const RELATIONS = ['related_to', 'context', 'resource', 'requirement', 'decision', 'evidence', 'lesson', 'deliverable'];
const expanded = ref(false);
const loading = ref(false);
const searching = ref(false);
const saving = ref(false);
const error = ref('');
const links = ref<LinkedKnowledgeRecord[]>([]);
const results = ref<KnowledgeNodeRecord[]>([]);
const chosen = ref<KnowledgeNodeRecord | null>(null);
const query = ref('');
const relation = ref('related_to');
const note = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  if (!props.itemId) return;
  loading.value = true;
  error.value = '';
  try {
    links.value = await ipcRenderer.invoke('work-items:knowledge-list', {
      itemKind: props.itemKind, itemId: props.itemId, includeInherited: true, limit: 100,
    });
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

function toggle(): void {
  expanded.value = !expanded.value;
  if (expanded.value) load();
}

function search(): void {
  chosen.value = null;
  if (searchTimer) clearTimeout(searchTimer);
  const term = query.value.trim();
  if (!term) {
    results.value = [];
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(async() => {
    try {
      results.value = await ipcRenderer.invoke('knowledge:nodes-search', { query: term, limit: 8 });
    } finally {
      searching.value = false;
    }
  }, 180);
}

async function attach(): Promise<void> {
  if (!chosen.value) return;
  saving.value = true;
  try {
    await ipcRenderer.invoke('work-items:knowledge-link', {
      itemKind:        props.itemKind,
      itemId:          props.itemId,
      knowledgeNodeId: chosen.value.id,
      relationType:    relation.value,
      note:            note.value || null,
      source:          'ui',
      actor:           'human',
    });
    query.value = ''; note.value = ''; chosen.value = null; results.value = [];
    await load();
  } finally {
    saving.value = false;
  }
}

async function unlink(link: LinkedKnowledgeRecord): Promise<void> {
  await ipcRenderer.invoke('work-items:knowledge-unlink', {
    itemKind:        props.itemKind,
    itemId:          props.itemId,
    knowledgeNodeId: link.node_id,
    relationType:    link.relation_type,
    source:          'ui',
    actor:           'human',
  });
  await load();
}

watch(() => [props.itemKind, props.itemId], () => {
  links.value = [];
  error.value = '';
  if (expanded.value) load();
});
</script>

<style scoped>
.knowledge-links { margin: 12px 0; border: 1px solid var(--pborder, var(--border)); border-radius: 10px; background: var(--psurf, var(--surface-1)); }
.kl-head { width: 100%; display: flex; justify-content: space-between; border: 0; padding: 10px 12px; background: transparent; color: var(--ptext, var(--text)); font-weight: 700; cursor: pointer; }
.kl-count, .kl-muted, .kl-meta, .kl-note { color: var(--ptext3, var(--text-muted)); font-size: 12px; }
.kl-body { padding: 0 12px 12px; }
.kl-row { display: flex; gap: 8px; border-top: 1px solid var(--pborder, var(--border)); padding: 9px 0; }
.kl-main, .kl-result { flex: 1; display: flex; flex-direction: column; gap: 3px; text-align: left; color: inherit; border: 0; background: transparent; cursor: pointer; }
.kl-meta { display: flex; gap: 7px; align-items: center; }
.kl-meta b, .kl-meta em { padding: 2px 6px; border-radius: 10px; background: var(--accent-dim); color: var(--accent); font-style: normal; }
.kl-meta em.inherited { background: var(--surface-3); color: var(--text-muted); }
.kl-remove { border: 0; background: transparent; color: var(--danger); font-size: 19px; cursor: pointer; }
.kl-error { color: var(--danger); font-size: 12px; }
.kl-attach { display: grid; gap: 6px; margin-top: 10px; }
.kl-attach input, .kl-attach select { min-width: 0; padding: 7px 9px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; }
.kl-result { padding: 7px; border: 1px solid var(--border); border-radius: 7px; }
.kl-result span { color: var(--text-muted); font-size: 12px; }
.kl-chosen { font-size: 12px; color: var(--text-muted); }
.kl-fields { display: grid; grid-template-columns: minmax(110px, .7fr) 1fr auto; gap: 6px; }
.kl-fields button { border: 0; border-radius: 7px; padding: 0 12px; background: var(--accent); color: white; cursor: pointer; }
</style>
