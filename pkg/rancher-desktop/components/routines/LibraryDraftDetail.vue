<template>
  <div class="page">
    <button
      type="button"
      class="back"
      @click="$emit('close')"
    >
      ← Back
    </button>

    <header>
      <div class="kicker">
        <span
          class="kind-badge"
          :class="`kind-${draft.kind}`"
        >{{ draft.kind }}</span>
        <span class="chip">draft</span>
        <span
          v-if="draft.base_slug"
          class="chip"
        >forked from {{ draft.base_slug }}</span>
      </div>
      <h1>{{ currentName || draft.slug }}</h1>
    </header>

    <div class="tabs">
      <button
        type="button"
        class="tab"
        :class="{ on: tab === 'form' }"
        @click="tab = 'form'"
      >
        Edit
      </button>
      <button
        type="button"
        class="tab"
        :class="{ on: tab === 'publish' }"
        @click="tab = 'publish'"
      >
        Publish
      </button>
    </div>

    <section
      v-if="tab === 'form'"
      class="panel"
    >
      <SkillManifestForm
        v-if="draft.kind === 'skill'"
        :model-value="editState"
        @update:model-value="onFormChange"
      />
      <FunctionManifestForm
        v-else-if="draft.kind === 'function'"
        :model-value="editState"
        @update:model-value="onFormChange"
      />
      <RecipeManifestForm
        v-else-if="draft.kind === 'recipe'"
        :model-value="editState"
        @update:model-value="onFormChange"
      />
      <IntegrationManifestForm
        v-else-if="draft.kind === 'integration'"
        :model-value="editState"
        @update:model-value="onFormChange"
      />
    </section>

    <section
      v-else-if="tab === 'publish'"
      class="panel"
    >
      <p class="hint">
        Publishing writes the draft somewhere permanent. Editing here stays in the database until you take one of these actions.
      </p>

      <div class="publish-card">
        <h4>Publish locally</h4>
        <p>Materialise this draft to <code>~/sulla/{{ kindPluralLabel }}/</code> so Sulla's runtime picks it up.</p>
        <label class="f">
          <span class="l">Target slug</span>
          <input
            v-model="localSlug"
            type="text"
          >
        </label>
        <button
          type="button"
          class="btn primary"
          :disabled="!!drafts.publishing.value || !localSlug.trim()"
          @click="doPublishLocal"
        >
          {{ drafts.publishing.value === 'local' ? 'Publishing…' : 'Publish to disk' }}
        </button>
      </div>

      <div class="publish-card">
        <h4>Publish to Marketplace</h4>
        <p>Upload this draft to Sulla Cloud for admin review. Approved submissions appear in the public marketplace for others to install.</p>
        <button
          type="button"
          class="btn primary"
          :disabled="!!drafts.publishing.value"
          @click="doPublishMarketplace"
        >
          {{ drafts.publishing.value === 'marketplace' ? 'Uploading…' : 'Publish to Marketplace' }}
        </button>
      </div>

      <div
        v-if="drafts.publishError.value"
        class="banner err"
      >
        {{ drafts.publishError.value }}
      </div>
      <div
        v-if="drafts.publishResult.value?.type === 'local'"
        class="banner ok"
      >
        Written → <code>{{ drafts.publishResult.value.path }}</code>
      </div>
      <div
        v-else-if="drafts.publishResult.value?.type === 'marketplace'"
        class="banner ok"
      >
        Submitted. Template ID: <code>{{ drafts.publishResult.value.templateId }}</code> (bundle {{ drafts.publishResult.value.bundleStatus }})
      </div>
    </section>

    <footer>
      <div
        v-if="drafts.saveError.value"
        class="err-small"
      >
        {{ drafts.saveError.value }}
      </div>
      <div class="actions">
        <button
          type="button"
          class="btn ghost"
          @click="$emit('close')"
        >
          Close
        </button>
        <button
          type="button"
          class="btn ghost danger"
          @click="onDelete"
        >
          Delete draft
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!dirty || drafts.saving.value"
          @click="doSave"
        >
          {{ drafts.saving.value ? 'Saving…' : (dirty ? 'Save draft' : 'Saved') }}
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import FunctionManifestForm from '@pkg/components/routines/forms/FunctionManifestForm.vue';
import IntegrationManifestForm from '@pkg/components/routines/forms/IntegrationManifestForm.vue';
import RecipeManifestForm from '@pkg/components/routines/forms/RecipeManifestForm.vue';
import SkillManifestForm from '@pkg/components/routines/forms/SkillManifestForm.vue';
import type { DraftDetail } from '@pkg/composables/useLibraryDrafts';
import { useLibraryDrafts } from '@pkg/composables/useLibraryDrafts';

interface EditState {
  manifest: Record<string, unknown>;
  files:    Record<string, string>;
}

const props = defineProps<{
  draft:  DraftDetail;
  drafts: ReturnType<typeof useLibraryDrafts>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'deleted'): void;
}>();

const tab = ref<'form' | 'publish'>('form');

const editState = ref<EditState>({
  manifest: props.draft.manifest_json,
  files:    props.draft.files_json,
});

const dirty = ref(false);

// Re-bind when the active draft switches in the parent (the composable
// swaps the whole object; we just take a fresh copy).
watch(() => props.draft.id, () => {
  editState.value = {
    manifest: props.draft.manifest_json,
    files:    props.draft.files_json,
  };
  dirty.value = false;
  tab.value = 'form';
});

const currentName = computed(() => {
  const m = editState.value.manifest as any;

  return (m?.metadata?.name as string | undefined) ?? '';
});

const kindPluralLabel = computed(() => ({
  skill: 'skills', function: 'functions', recipe: 'recipes', integration: 'integrations',
} as const)[props.draft.kind]);

const localSlug = ref(props.draft.slug);
watch(() => props.draft.id, () => { localSlug.value = props.draft.slug });

function onFormChange(next: EditState) {
  editState.value = next;
  dirty.value = true;
}

async function doSave() {
  const ok = await props.drafts.save({
    manifest_json: editState.value.manifest,
    files_json:    editState.value.files,
  });
  if (ok) dirty.value = false;
}

async function onDelete() {
  if (!window.confirm('Delete this draft permanently?')) return;
  const ok = await props.drafts.remove(props.draft.id);
  if (ok) emit('deleted');
}

async function doPublishLocal() {
  if (dirty.value) await doSave();
  await props.drafts.publishLocal(localSlug.value);
}

async function doPublishMarketplace() {
  if (dirty.value) await doSave();
  await props.drafts.publishMarketplace();
}
</script>

<style scoped lang="scss">
.page {
  padding: 24px 8px 40px;
  color: var(--steel-100, white);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.back {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.3);
  color: var(--steel-200);
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  align-self: flex-start;
  margin-bottom: 8px;
}
.back:hover { border-color: var(--steel-300); color: white; }

.kicker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
h1 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 38px;
  line-height: 1.1;
  color: white;
  margin: 0;
}
h2 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 30px;
  line-height: 1.1;
  color: white;
  margin: 0;
}
.chip {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.4);
}
.kind-badge {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: white;
}
.kind-badge.kind-skill       { background: rgba(245, 158, 11, 0.35); border-color: rgba(245, 158, 11, 0.6); }
.kind-badge.kind-function    { background: rgba(6, 182, 212, 0.35);  border-color: rgba(6, 182, 212, 0.6); }
.kind-badge.kind-recipe      { background: rgba(192, 38, 211, 0.35); border-color: rgba(192, 38, 211, 0.6); }
.kind-badge.kind-integration { background: rgba(96, 165, 250, 0.35); border-color: rgba(96, 165, 250, 0.6); }

.tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 6px;
}
.tab {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  background: transparent;
  color: var(--steel-300);
  cursor: pointer;
}
.tab.on {
  color: white;
  background: rgba(74, 111, 165, 0.22);
  border-color: rgba(140, 172, 201, 0.5);
}

.panel {
  flex: 1;
  min-height: 0;
}

.hint {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--steel-400);
  margin: 0 0 12px;
  line-height: 1.55;
}
.hint code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.5);
  padding: 1px 5px;
  border-radius: 3px;
}

.file-entry {
  margin-bottom: 14px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(4, 8, 18, 0.3);
}
.file-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}
.file-head code {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--steel-100);
}
.file-head .size {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-400);
}
.file-body {
  width: 100%;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  background: rgba(4, 8, 18, 0.8);
  color: var(--steel-100);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px 12px;
  resize: vertical;
}

.publish-card {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(10, 18, 36, 0.4);
  margin-bottom: 14px;
}
.publish-card h4 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-300);
  margin: 0 0 8px;
}
.publish-card p {
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--steel-200);
  margin: 0 0 12px;
  line-height: 1.55;
}
.publish-card p code {
  font-family: var(--mono);
  font-size: 11.5px;
}
.f { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.l {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-400);
}
input {
  font-family: var(--sans);
  font-size: 13px;
  color: white;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  outline: none;
}

.banner {
  padding: 12px 14px;
  border-radius: 4px;
  font-family: var(--sans);
  font-size: 12.5px;
  margin-top: 10px;
}
.banner.err { background: rgba(127, 29, 29, 0.2); color: #fca5a5; border: 1px solid rgba(248, 113, 113, 0.3); }
.banner.ok  { background: rgba(4, 58, 34, 0.25);  color: #86efac; border: 1px solid rgba(134, 239, 172, 0.3); }

footer {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.err-small {
  color: #f87171;
  font-family: var(--sans);
  font-size: 12px;
  margin-bottom: 10px;
}
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 9px 18px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  color: var(--steel-200);
}
.btn.ghost { border-color: rgba(168, 192, 220, 0.3); }
.btn.ghost:hover { border-color: var(--steel-300); color: white; }
.btn.ghost.danger { color: #fca5a5; border-color: rgba(248, 113, 113, 0.35); }
.btn.ghost.danger:hover { color: #f87171; border-color: rgba(248, 113, 113, 0.6); }
.btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}
.btn.primary:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
