<template>
  <section
    class="template-settings"
    aria-labelledby="template-settings-title"
  >
    <header class="pt-head">
      <div>
        <h2 id="template-settings-title">
          Pipeline templates
        </h2>
        <p>Reusable ordered stages. Applying a template materializes an independent pipeline for an empty project.</p>
      </div>
      <button
        type="button"
        :disabled="busy"
        @click="newTemplate"
      >
        New template
      </button>
    </header>

    <div
      v-if="failure"
      class="pt-error"
      role="alert"
    >
      {{ failure }}
    </div>
    <div
      v-if="message"
      class="pt-message"
      role="status"
    >
      {{ message }}
    </div>

    <div class="pt-layout">
      <nav aria-label="Pipeline templates">
        <button
          v-for="template in templates"
          :key="template.id"
          type="button"
          :class="{ on: template.id === selectedId }"
          @click="selectTemplate(template.id)"
        >
          <strong>{{ template.name }}</strong>
          <small>{{ template.system ? 'Core' : `v${template.version}` }}</small>
        </button>
      </nav>

      <form
        class="pt-editor"
        @submit.prevent="save"
      >
        <template v-if="draft">
          <label>Template key <input
            v-model="draft.templateKey"
            :disabled="!creating"
            required
            pattern="[a-z0-9_-]+"
          ></label>
          <label>Name <input
            v-model="draft.name"
            :disabled="readonly"
            required
          ></label>
          <label>Description <textarea
            v-model="draft.description"
            :disabled="readonly"
            rows="2"
          /></label>

          <div class="pt-stage-head">
            <b>Ordered stages</b>
            <button
              v-if="!readonly"
              type="button"
              @click="addStage"
            >
              ＋ Add stage
            </button>
          </div>
          <div class="pt-stages">
            <article
              v-for="(stage, index) in draft.stages"
              :key="`${stage.stageKey}-${index}`"
              class="pt-stage"
            >
              <div class="pt-order">
                <button
                  type="button"
                  :disabled="readonly || index === 0"
                  aria-label="Move stage up"
                  @click="moveStage(index, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  :disabled="readonly || index === draft.stages.length - 1"
                  aria-label="Move stage down"
                  @click="moveStage(index, 1)"
                >
                  ↓
                </button>
              </div>
              <label>Key <input
                v-model="stage.stageKey"
                :disabled="readonly"
                required
                pattern="[a-z0-9_-]+"
              ></label>
              <label>Name <input
                v-model="stage.displayName"
                :disabled="readonly"
                required
              ></label>
              <label>Role
                <select
                  v-model="stage.semanticRole"
                  :disabled="readonly"
                >
                  <option
                    v-for="role in ROLES"
                    :key="role"
                    :value="role"
                  >{{ role }}</option>
                </select>
              </label>
              <label>Workflow
                <select
                  v-model="stage.workflowId"
                  :disabled="readonly"
                >
                  <option :value="null">Manual / none</option>
                  <option
                    v-for="workflow in workflows"
                    :key="workflow.id"
                    :value="workflow.id"
                  >{{ workflow.name }}</option>
                </select>
              </label>
              <label>WIP <input
                v-model.number="stage.wipLimit"
                :disabled="readonly"
                min="1"
                type="number"
                placeholder="∞"
              ></label>
              <button
                v-if="!readonly"
                type="button"
                class="danger"
                @click="removeStage(index)"
              >
                Remove
              </button>
            </article>
          </div>

          <footer>
            <button
              v-if="!readonly"
              type="submit"
              :disabled="busy || !draft.stages.length"
            >
              {{ creating ? 'Create template' : 'Save template' }}
            </button>
            <button
              v-if="!creating"
              type="button"
              :disabled="busy || hasActiveTasks"
              @click="applySelected"
            >
              Apply to this project
            </button>
            <button
              v-if="!creating && !readonly"
              type="button"
              class="danger"
              :disabled="busy"
              @click="archiveSelected"
            >
              Archive
            </button>
          </footer>
          <p
            v-if="hasActiveTasks"
            class="pt-note"
          >
            Templates can only be applied before a project has active tasks.
          </p>
          <p
            v-if="readonly"
            class="pt-note"
          >
            The bundled core template is locked. Create a custom template to edit its shape.
          </p>
        </template>
        <div
          v-else
          class="pt-empty"
        >
          Select or create a pipeline template.
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { WorkLaneSemanticRole } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import { useProjects, type ProjectPipelineTemplate, type ProjectView } from '@pkg/composables/useProjects';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface TemplateStageDraft {
  stageKey:     string;
  displayName:  string;
  description:  string;
  semanticRole: WorkLaneSemanticRole;
  workflowId:   string | null;
  wipLimit:     number | null;
}

interface TemplateDraft {
  templateKey: string;
  name:        string;
  description: string;
  stages:      TemplateStageDraft[];
  locked:      boolean;
  system:      boolean;
}

const props = defineProps<{ project: ProjectView }>();
const emit = defineEmits<{ refresh: [] }>();
const {
  listPipelineTemplates, getPipelineTemplate, createPipelineTemplate, updatePipelineTemplate,
  archivePipelineTemplate, applyPipelineTemplate,
} = useProjects();

const ROLES: WorkLaneSemanticRole[] = ['backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual'];
const templates = ref<Awaited<ReturnType<typeof listPipelineTemplates>>>([]);
const workflows = ref<{ id: string; name: string }[]>([]);
const selectedId = ref('');
const creating = ref(false);
const busy = ref(false);
const failure = ref('');
const message = ref('');
const draft = ref<TemplateDraft | null>(null);

const readonly = computed(() => Boolean(draft.value?.locked || draft.value?.system));
const hasActiveTasks = computed(() => props.project.epics.some(epic => epic.tasks.some(task => !task.archived)));

function assignDraft(template: ProjectPipelineTemplate): void {
  draft.value = {
    templateKey: template.template_key,
    name:        template.name,
    description: template.description,
    locked:      template.locked,
    system:      template.system,
    stages:      template.stages.map(stage => ({
      stageKey:     stage.stage_key,
      displayName:  stage.display_name,
      description:  stage.description,
      semanticRole: (stage.semantic_role ?? 'manual') as WorkLaneSemanticRole,
      workflowId:   stage.bundled_workflow_id,
      wipLimit:     stage.wip_limit,
    })),
  };
}

async function reload(): Promise<void> {
  busy.value = true;
  failure.value = '';
  try {
    templates.value = await listPipelineTemplates(false);
    workflows.value = (await ipcRenderer.invoke('workflow-db-list'))
      .filter(workflow => workflow.status !== 'archive')
      .map(workflow => ({ id: workflow.id, name: workflow.name }));
    if (!selectedId.value && templates.value[0]) await selectTemplate(templates.value[0].id);
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function selectTemplate(templateId: string): Promise<void> {
  selectedId.value = templateId;
  creating.value = false;
  failure.value = '';
  const template = await getPipelineTemplate(templateId);
  if (!template) {
    failure.value = `Pipeline template not found: ${ templateId }`;
    return;
  }
  assignDraft(template);
}

function newTemplate(): void {
  creating.value = true;
  selectedId.value = '';
  draft.value = {
    templateKey: '',
    name:        '',
    description: '',
    locked:      false,
    system:      false,
    stages:      [{ stageKey: 'start', displayName: 'Start', description: '', semanticRole: 'manual', workflowId: null, wipLimit: null }],
  };
}

function addStage(): void {
  draft.value?.stages.push({ stageKey: `stage-${ (draft.value?.stages.length ?? 0) + 1 }`, displayName: 'New stage', description: '', semanticRole: 'manual', workflowId: null, wipLimit: null });
}

function removeStage(index: number): void { draft.value?.stages.splice(index, 1) }
function moveStage(index: number, delta: number): void {
  if (!draft.value) return;
  const target = index + delta;
  if (target < 0 || target >= draft.value.stages.length) return;
  [draft.value.stages[index], draft.value.stages[target]] = [draft.value.stages[target], draft.value.stages[index]];
}

function stageInput() {
  return (draft.value?.stages ?? []).map((stage, index) => ({
    ...stage,
    position:     (index + 1) * 10,
    semanticRole: stage.semanticRole,
    workflowId:   stage.workflowId || null,
    wipLimit:     stage.wipLimit || null,
  }));
}

async function save(): Promise<void> {
  if (!draft.value) return;
  busy.value = true; failure.value = ''; message.value = '';
  try {
    const saved = creating.value
      ? await createPipelineTemplate({ templateKey: draft.value.templateKey, name: draft.value.name, description: draft.value.description, stages: stageInput() })
      : await updatePipelineTemplate(selectedId.value, { name: draft.value.name, description: draft.value.description, stages: stageInput() });
    creating.value = false;
    selectedId.value = saved.id;
    message.value = 'Pipeline template saved.';
    await reload();
    await selectTemplate(saved.id);
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}

async function applySelected(): Promise<void> {
  if (!selectedId.value) return;
  busy.value = true; failure.value = ''; message.value = '';
  try {
    await applyPipelineTemplate(props.project.id, selectedId.value);
    message.value = 'Pipeline template applied to this project.';
    emit('refresh');
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}

async function archiveSelected(): Promise<void> {
  if (!selectedId.value) return;
  busy.value = true; failure.value = ''; message.value = '';
  try {
    await archivePipelineTemplate(selectedId.value);
    selectedId.value = '';
    message.value = 'Pipeline template archived.';
    await reload();
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}

watch(() => props.project.id, () => { reload().catch(() => undefined) }, { immediate: true });
</script>

<style scoped>
.template-settings { margin-top: 34px; padding-top: 24px; border-top: 1px solid var(--pborder); color: var(--ptext); }
.pt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
.pt-head h2 { margin: 0; font-family: var(--pserif); font-weight: 500; }.pt-head p { margin: 5px 0 0; color: var(--ptext2); font-size: 12px; }
.pt-head button, .pt-editor button { border: 1px solid var(--pborder); border-radius: 7px; background: transparent; color: var(--ptext2); padding: 7px 9px; cursor: pointer; }
.pt-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 14px; }
.pt-layout nav { display: flex; flex-direction: column; gap: 5px; }.pt-layout nav button { display: flex; justify-content: space-between; gap: 8px; border: 1px solid var(--pborder); border-radius: 7px; background: var(--psurface); color: var(--ptext2); padding: 9px; text-align: left; cursor: pointer; }.pt-layout nav button.on { border-color: var(--pacc-line); color: var(--ptext); background: var(--pacc-soft); }.pt-layout nav small { font: 9px var(--pmono); color: var(--ptext3); }
.pt-editor { min-width: 0; border: 1px solid var(--pborder); border-radius: 10px; background: var(--psurface); padding: 14px; }.pt-editor > label, .pt-stage label { display: grid; gap: 4px; color: var(--ptext2); font-size: 11px; margin-bottom: 9px; }.pt-editor input, .pt-editor textarea, .pt-editor select { width: 100%; border: 1px solid var(--pborder); border-radius: 6px; background: var(--psurface2); color: var(--ptext); padding: 7px; }
.pt-stage-head { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 8px; }.pt-stage-head b { font-size: 12px; }
.pt-stages { display: grid; gap: 7px; }.pt-stage { display: grid; grid-template-columns: auto 1fr 1.2fr 1fr 1.2fr 70px auto; align-items: end; gap: 7px; border: 1px solid var(--pborder); border-radius: 8px; background: var(--psurface2); padding: 9px; }.pt-stage label { margin: 0; }.pt-order { display: grid; gap: 3px; }.pt-order button { padding: 3px 6px; }
.pt-editor footer { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }.danger { color: var(--pred) !important; }.pt-note { color: var(--ptext3); font-size: 10px; }.pt-error, .pt-message { margin-bottom: 10px; padding: 9px; border-radius: 7px; font-size: 11px; }.pt-error { color: var(--pred); background: rgba(201,115,111,.1); }.pt-message { color: var(--pacc); background: var(--pacc-soft); }.pt-empty { color: var(--ptext2); }
@media (max-width: 1000px) { .pt-layout { grid-template-columns: 1fr; }.pt-layout nav { flex-direction: row; overflow-x: auto; }.pt-stage { grid-template-columns: auto 1fr 1fr; } }
</style>
