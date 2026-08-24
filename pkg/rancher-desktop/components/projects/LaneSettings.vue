<template>
  <section
    class="lane-settings"
    aria-labelledby="lane-settings-title"
  >
    <header class="ls-head">
      <div>
        <h2 id="lane-settings-title">
          Lane settings
        </h2>
        <p>Customize presentation without changing stable task status keys.</p>
      </div>
      <div
        class="ls-scope"
        role="group"
        aria-label="Lane settings scope"
      >
        <button
          :class="{ on: scope === 'project' }"
          type="button"
          @click="setScope('project')"
        >
          This project
        </button>
        <button
          :class="{ on: scope === 'global_default' }"
          type="button"
          @click="setScope('global_default')"
        >
          Global defaults
        </button>
      </div>
    </header>

    <div
      v-if="message"
      class="ls-message"
      role="status"
    >
      {{ message }}
    </div>
    <div
      v-if="failure"
      class="ls-error"
      role="alert"
    >
      {{ failure }}
    </div>
    <div
      v-if="loading"
      class="ls-empty"
    >
      Loading lanes…
    </div>
    <div
      v-else
      class="ls-list"
    >
      <article
        v-for="(lane, index) in lanes"
        :key="lane.id"
        class="ls-row"
        :class="{ archived: lane.archived }"
      >
        <span
          class="ls-color"
          :style="{ background: lane.color || 'var(--pacc)' }"
        />
        <div class="ls-copy">
          <div class="ls-title">
            {{ lane.display_name }}
            <code>{{ lane.lane_key }}</code>
          </div>
          <p>{{ lane.description || 'No description' }}</p>
          <div class="ls-badges">
            <span>{{ provenanceLabel(lane) }}</span>
            <span>{{ lane.semantic_role }}</span>
            <span v-if="lane.system_required">protected required</span>
            <span v-if="lane.archived">archived</span>
            <span v-else>{{ lane.semantic_role === 'manual' ? 'manual' : 'automated-capable' }}</span>
          </div>
        </div>
        <div class="ls-actions">
          <button
            type="button"
            :disabled="busy || index === 0 || lane.archived"
            aria-label="Move lane left"
            @click="move(index, -1)"
          >
            ←
          </button>
          <button
            type="button"
            :disabled="busy || index === lanes.length - 1 || lane.archived"
            aria-label="Move lane right"
            @click="move(index, 1)"
          >
            →
          </button>
          <button
            type="button"
            :disabled="busy || lane.archived"
            @click="openEdit(lane)"
          >
            Customize
          </button>
          <button
            type="button"
            :disabled="busy || lane.archived"
            @click="openAssignment(lane)"
          >
            Assign workflow
          </button>
          <button
            v-if="lane.provenance === 'project_override'"
            type="button"
            :disabled="busy"
            @click="resetOverride(lane)"
          >
            Reset override
          </button>
          <button
            v-if="lane.archived"
            type="button"
            :disabled="busy"
            @click="restore(lane)"
          >
            Restore
          </button>
          <button
            v-else
            type="button"
            class="danger"
            :disabled="busy || lane.system_required"
            @click="openArchive(lane)"
          >
            Archive
          </button>
        </div>
      </article>
    </div>
    <button
      type="button"
      class="ls-add"
      :disabled="busy"
      @click="openCreate"
    >
      ＋ Add {{ scope === 'project' ? 'project-only' : 'default' }} lane
    </button>
    <button
      v-if="scope === 'project' && lanes.some(lane => lane.provenance === 'project_override')"
      type="button"
      class="ls-add"
      :disabled="busy"
      @click="resetAllOverrides"
    >
      Reset all project overrides
    </button>

    <div
      v-if="editor.open"
      class="ls-scrim"
      @click="editor.open = false"
    >
      <form
        class="ls-modal"
        @submit.prevent="saveLane"
        @click.stop
      >
        <h3>{{ editor.create ? 'Add lane' : 'Customize lane' }}</h3>
        <label>Stable key <input
          v-model="editor.laneKey"
          :disabled="!editor.create"
          required
          pattern="[a-z0-9_-]+"
        ></label>
        <small>The key is permanent; renaming only changes the display name.</small>
        <label>Display name <input
          v-model="editor.displayName"
          required
        ></label>
        <label>Description <textarea
          v-model="editor.description"
          rows="3"
        /></label>
        <div class="ls-grid">
          <label>Color <input
            v-model="editor.color"
            type="color"
          ></label>
          <label>Semantic role
            <select v-model="editor.semanticRole">
              <option
                v-for="role in ROLES"
                :key="role"
                :value="role"
              >{{ role }}</option>
            </select>
          </label>
        </div>
        <div class="ls-footer">
          <button
            type="submit"
            :disabled="busy"
          >
            {{ busy ? 'Saving…' : 'Save' }}
          </button>
          <button
            type="button"
            @click="editor.open = false"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>

    <div
      v-if="archiveDialog.open"
      class="ls-scrim"
      @click="archiveDialog.open = false"
    >
      <form
        class="ls-modal"
        @submit.prevent="archiveSelected"
        @click.stop
      >
        <h3>Archive {{ archiveDialog.lane?.display_name }}</h3>
        <p v-if="archiveDialog.preview?.protected">
          This lane is required by the task lifecycle and can’t be archived.
        </p>
        <template v-else>
          <p>This will archive the lane. {{ archiveDialog.preview?.taskCount || 0 }} task(s) currently use it.</p>
          <label v-if="(archiveDialog.preview?.taskCount || 0) > 0">Move tasks to
            <select
              v-model="archiveDialog.destination"
              required
            >
              <option
                value=""
                disabled
              >Select a destination</option>
              <option
                v-for="destination in archiveDialog.preview?.destinations"
                :key="destination.lane_key"
                :value="destination.lane_key"
              >
                {{ destination.display_name }}
              </option>
            </select>
          </label>
        </template>
        <div class="ls-footer">
          <button
            type="submit"
            class="danger"
            :disabled="busy || archiveDialog.preview?.protected"
          >
            Archive and move
          </button>
          <button
            type="button"
            @click="archiveDialog.open = false"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>

    <div
      v-if="assignment.open"
      class="ls-scrim"
      @click="assignment.open = false"
    >
      <form
        class="ls-modal wide"
        @submit.prevent="saveAssignment"
        @click.stop
      >
        <h3>Assign workflow · {{ assignment.lane?.display_name }}</h3>
        <fieldset>
          <legend>Apply to</legend>
          <label><input
            v-model="assignment.scope"
            type="radio"
            value="epic"
          > This epic</label>
          <label><input
            v-model="assignment.scope"
            type="radio"
            value="project"
          > This project</label>
          <label><input
            v-model="assignment.scope"
            type="radio"
            value="global"
          > Every project using this lane type</label>
        </fieldset>
        <p class="ls-target">
          Affected target: <strong>{{ affectedTarget }}</strong>
        </p>
        <label v-if="assignment.scope === 'epic'">Epic
          <select
            v-model="assignment.epicId"
            required
            @change="refreshResolution"
          >
            <option
              v-for="epic in project.epics"
              :key="epic.id"
              :value="epic.id"
            >{{ epic.title }}</option>
          </select>
        </label>
        <label>Compatible workflow
          <select
            v-model="assignment.workflowId"
            required
          >
            <option
              value=""
              disabled
            >Select an enabled compatible workflow</option>
            <option
              v-for="workflow in assignment.workflows"
              :key="workflow.id"
              :value="workflow.id"
            >
              {{ workflow.name }}{{ workflow.system ? ' · protected core' : '' }}
            </option>
          </select>
        </label>
        <p
          v-if="!assignment.loading && !assignment.workflows.length"
          class="ls-error"
        >
          No enabled workflow declares a compatible lane contract.
        </p>
        <div class="ls-provenance">
          <b>Current precedence</b>
          <ol>
            <li
              v-for="step in precedence"
              :key="step.scope"
              :class="{ effective: step.effective }"
            >
              {{ step.label }} — {{ step.workflow }}
            </li>
          </ol>
          <p>Effective now: <strong>{{ effectiveWorkflowLabel }}</strong> <span class="ls-badge">{{ provenanceBadge }}</span></p>
          <p v-if="assignment.resolution?.fallbackReason">
            Fallback: {{ assignment.resolution.fallbackReason }}
          </p>
        </div>
        <div class="ls-footer">
          <button
            type="submit"
            :disabled="busy || !assignment.workflowId || !assignment.workflows.length"
          >
            Save assignment
          </button>
          <button
            v-if="assignment.exactBinding"
            type="button"
            :disabled="busy"
            @click="removeAssignment"
          >
            Use inherited fallback
          </button>
          <button
            type="button"
            @click="assignment.open = false"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';

import type {
  ArchiveWorkLanePreview, EffectiveWorkLane, WorkLaneSemanticRole,
} from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import type {
  CompatibleLaneWorkflow, LaneBindingResolution, LaneWorkflowBindingRecord, LaneBindingScope,
} from '@pkg/agent/database/models/WorkLaneWorkflowBindingModel';
import { useProjects, type ProjectView } from '@pkg/composables/useProjects';

const props = defineProps<{ project: ProjectView }>();
const emit = defineEmits<{ refresh: [] }>();
const {
  listLanes, resolveLanes, createLane, updateLane, archiveLane, previewArchiveLane, restoreLane,
  reorderLanes, resetLaneOverride, listLaneWorkflowBindings, setLaneWorkflowBinding,
  removeLaneWorkflowBinding, resolveLaneWorkflowContext, listCompatibleLaneWorkflows,
} = useProjects();

const ROLES: WorkLaneSemanticRole[] = ['backlog', 'planning', 'execution', 'review', 'blocked', 'terminal', 'manual'];
const scope = ref<'project' | 'global_default'>('project');
const lanes = ref<EffectiveWorkLane[]>([]);
const loading = ref(false);
const busy = ref(false);
const failure = ref('');
const message = ref('');

const editor = reactive({
  open:         false,
  create:       false,
  lane:         null as EffectiveWorkLane | null,
  laneKey:      '',
  displayName:  '',
  description:  '',
  color:        '#5096b3',
  semanticRole: 'manual' as WorkLaneSemanticRole,
});
const archiveDialog = reactive({
  open: false, lane: null as EffectiveWorkLane | null, preview: null as ArchiveWorkLanePreview | null, destination: '',
});
const assignment = reactive({
  open:         false,
  loading:      false,
  lane:         null as EffectiveWorkLane | null,
  scope:        'project' as Exclude<LaneBindingScope, 'core'>,
  epicId:       '',
  workflowId:   '',
  workflows:    [] as CompatibleLaneWorkflow[],
  bindings:     [] as LaneWorkflowBindingRecord[],
  resolution:   null as LaneBindingResolution | null,
  exactBinding: null as LaneWorkflowBindingRecord | null,
});

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true; failure.value = ''; message.value = '';
  try { await action() } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}

async function reload(): Promise<void> {
  loading.value = true; failure.value = '';
  try {
    if (scope.value === 'project') lanes.value = await resolveLanes(props.project.id, true);
    else {
      lanes.value = (await listLanes({ scope: 'global_default', includeArchived: true }))
        .map(lane => ({ ...lane, provenance: 'global' as const, inherited_definition_id: null }));
    }
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { loading.value = false }
}

function setScope(next: 'project' | 'global_default'): void { scope.value = next }
watch(() => [props.project.id, scope.value], () => { reload().catch(() => undefined) }, { immediate: true });

function provenanceLabel(lane: EffectiveWorkLane): string {
  if (lane.provenance === 'global') return scope.value === 'project' ? 'inherited default' : 'global default';
  return lane.provenance === 'project_override' ? 'project override' : 'project-only';
}

function openCreate(): void {
  Object.assign(editor, { open: true, create: true, lane: null, laneKey: '', displayName: '', description: '', color: '#5096b3', semanticRole: 'manual' });
}
function openEdit(lane: EffectiveWorkLane): void {
  Object.assign(editor, { open: true, create: false, lane, laneKey: lane.lane_key, displayName: lane.display_name, description: lane.description, color: lane.color || '#5096b3', semanticRole: lane.semantic_role });
}
async function saveLane(): Promise<void> {
  await run(async() => {
    if (editor.create) {
      await createLane({
        lane_key:      editor.laneKey,
        scope:         scope.value,
        project_id:    scope.value === 'project' ? props.project.id : null,
        display_name:  editor.displayName,
        description:   editor.description,
        color:         editor.color,
        semantic_role: editor.semanticRole,
        position:      lanes.value.length,
      });
    } else if (editor.lane) {
      if (scope.value === 'project' && editor.lane.provenance === 'global') {
        await createLane({
          lane_key:      editor.lane.lane_key,
          scope:         'project',
          project_id:    props.project.id,
          base_lane_key: editor.lane.lane_key,
          display_name:  editor.displayName,
          description:   editor.description,
          color:         editor.color,
          icon:          editor.lane.icon,
          position:      editor.lane.position,
          semantic_role: editor.semanticRole,
        });
      } else {
        await updateLane(editor.lane.id, { display_name: editor.displayName, description: editor.description, color: editor.color, semantic_role: editor.semanticRole });
      }
    }
    editor.open = false; message.value = 'Lane saved.'; await reload(); emit('refresh');
  });
}

async function move(index: number, delta: number): Promise<void> {
  const reordered = [...lanes.value];
  const target = index + delta;
  if (target < 0 || target >= reordered.length) return;
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  await run(async() => {
    await reorderLanes(scope.value, reordered.filter(lane => !lane.archived).map(lane => lane.lane_key), scope.value === 'project' ? props.project.id : undefined);
    await reload(); emit('refresh');
  });
}

async function resetOverride(lane: EffectiveWorkLane): Promise<void> {
  await run(async() => { await resetLaneOverride(props.project.id, lane.lane_key); message.value = 'Inherited defaults restored.'; await reload(); emit('refresh') });
}
async function resetAllOverrides(): Promise<void> {
  await run(async() => {
    const overrides = lanes.value.filter(lane => lane.provenance === 'project_override');
    await Promise.all(overrides.map(lane => resetLaneOverride(props.project.id, lane.lane_key)));
    message.value = `${ overrides.length } project override(s) reset to inherited defaults.`;
    await reload();
    emit('refresh');
  });
}
async function restore(lane: EffectiveWorkLane): Promise<void> {
  await run(async() => { await restoreLane(lane.id); message.value = 'Lane restored.'; await reload(); emit('refresh') });
}
async function openArchive(lane: EffectiveWorkLane): Promise<void> {
  archiveDialog.open = true; archiveDialog.lane = lane; archiveDialog.preview = null; archiveDialog.destination = '';
  await run(async() => {
    if (scope.value === 'project' && lane.provenance === 'global') {
      archiveDialog.preview = {
        taskCount:    props.project.epics.flatMap(epic => epic.tasks).filter(task => task.status === lane.lane_key).length,
        protected:    lane.system_required,
        destinations: lanes.value.filter(item => item.lane_key !== lane.lane_key && item.enabled && !item.archived),
      };
    } else {
      archiveDialog.preview = await previewArchiveLane(lane.id);
    }
  });
}
async function archiveSelected(): Promise<void> {
  if (!archiveDialog.lane) return;
  await run(async() => {
    let archiveId = archiveDialog.lane!.id;
    if (scope.value === 'project' && archiveDialog.lane!.provenance === 'global') {
      const inherited = archiveDialog.lane!;
      const override = await createLane({
        lane_key:      inherited.lane_key,
        scope:         'project',
        project_id:    props.project.id,
        base_lane_key: inherited.lane_key,
        display_name:  inherited.display_name,
        description:   inherited.description,
        color:         inherited.color,
        icon:          inherited.icon,
        position:      inherited.position,
        semantic_role: inherited.semantic_role,
      });
      archiveId = override.id;
    }
    const result = await archiveLane(archiveId, archiveDialog.destination || undefined);
    archiveDialog.open = false; message.value = `Lane archived; ${ result.movedTasks } task(s) moved.`; await reload(); emit('refresh');
  });
}

function bindingFor(scopeName: LaneBindingScope): LaneWorkflowBindingRecord | null {
  if (!assignment.lane) return null;
  return assignment.bindings.find((binding) => {
    if (binding.scope !== scopeName) return false;
    if (scopeName === 'epic') return binding.epic_id === assignment.epicId && binding.lane_key === assignment.lane!.lane_key;
    if (scopeName === 'project') return binding.project_id === props.project.id && binding.lane_key === assignment.lane!.lane_key;
    return binding.lane_key === assignment.lane!.lane_key ||
      (!binding.lane_key && binding.semantic_role === assignment.lane!.semantic_role);
  }) ?? null;
}
function exactBindingForScope(): LaneWorkflowBindingRecord | null {
  if (!assignment.lane) return null;
  return assignment.bindings.find(binding => binding.scope === assignment.scope &&
    binding.lane_key === assignment.lane!.lane_key &&
    (assignment.scope !== 'epic' || binding.epic_id === assignment.epicId) &&
    (assignment.scope !== 'project' || binding.project_id === props.project.id)) ?? null;
}
async function refreshResolution(): Promise<void> {
  if (!assignment.lane) return;
  assignment.bindings = await listLaneWorkflowBindings();
  assignment.resolution = await resolveLaneWorkflowContext({
    projectId: props.project.id, epicId: assignment.epicId || undefined, laneKey: assignment.lane.lane_key,
  });
  assignment.exactBinding = exactBindingForScope();
}
async function openAssignment(lane: EffectiveWorkLane, epicId?: string): Promise<void> {
  Object.assign(assignment, {
    open:         true,
    loading:      true,
    lane,
    scope:        epicId ? 'epic' : 'project',
    epicId:       epicId || props.project.epics[0]?.id || '',
    workflowId:   '',
    workflows:    [],
    bindings:     [],
    resolution:   null,
    exactBinding: null,
  });
  try {
    [assignment.workflows] = await Promise.all([
      listCompatibleLaneWorkflows(props.project.id, lane.lane_key), refreshResolution(),
    ]);
    assignment.exactBinding = exactBindingForScope();
    assignment.workflowId = assignment.exactBinding?.workflow_id ?? assignment.resolution?.workflowId ?? '';
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error) } finally { assignment.loading = false }
}
watch(() => assignment.scope, () => {
  if (!assignment.open) return;
  assignment.exactBinding = exactBindingForScope();
  assignment.workflowId = assignment.exactBinding?.workflow_id ?? assignment.resolution?.workflowId ?? '';
});

async function saveAssignment(): Promise<void> {
  if (!assignment.lane || !assignment.workflowId) return;
  await run(async() => {
    await setLaneWorkflowBinding({
      scope:      assignment.scope,
      workflowId: assignment.workflowId,
      laneKey:    assignment.lane!.lane_key,
      epicId:     assignment.scope === 'epic' ? assignment.epicId : undefined,
      projectId:  assignment.scope === 'project' ? props.project.id : undefined,
    });
    await refreshResolution(); message.value = `Workflow assigned. Effective source: ${ assignment.resolution?.source ?? 'none' }.`;
  });
}
async function removeAssignment(): Promise<void> {
  if (!assignment.exactBinding) return;
  await run(async() => { await removeLaneWorkflowBinding(assignment.exactBinding!.id); await refreshResolution(); message.value = 'Override removed; inherited fallback restored.' });
}

const precedence = computed(() => ['epic', 'project', 'global', 'core'].map((item) => {
  const binding = bindingFor(item as LaneBindingScope);
  return {
    scope:     item,
    label:     item === 'core' ? 'Protected core' : `${ item[0].toUpperCase() }${ item.slice(1) } override`,
    workflow:  binding?.workflow_id ?? 'not assigned',
    effective: assignment.resolution?.source === item,
  };
}));
const effectiveWorkflowLabel = computed(() => assignment.resolution?.workflowId ?? (assignment.resolution?.source === 'manual' ? 'Manual lane' : 'No automation'));
const affectedTarget = computed(() => {
  if (assignment.scope === 'global') return `all projects using lane key ${ assignment.lane?.lane_key ?? '' }`;
  if (assignment.scope === 'project') return props.project.title;
  return props.project.epics.find(epic => epic.id === assignment.epicId)?.title ?? 'Select an epic';
});
const provenanceBadge = computed(() => {
  const source = assignment.resolution?.source;
  return source === 'epic' ? 'epic override' : source === 'project' ? 'project override' : source === 'global' ? 'global default' : source === 'core' ? 'protected core' : source || 'none';
});

defineExpose({ openEdit, openAssignment });
</script>

<style scoped>
.lane-settings { max-width: 1100px; color: var(--ptext); }
.ls-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 20px; }
.ls-head h2, .ls-modal h3 { font-family: var(--pserif); font-weight: 500; margin: 0 0 6px; }
.ls-head p, .ls-copy p, .ls-modal p, .ls-modal small { color: var(--ptext2); margin: 0; line-height: 1.5; }
.ls-scope { display: flex; border: 1px solid var(--pborder); border-radius: 8px; overflow: hidden; }
.ls-scope button, .ls-actions button, .ls-add, .ls-footer button { background: transparent; border: 0; color: var(--ptext2); padding: 8px 10px; cursor: pointer; }
.ls-scope button.on, .ls-footer button:first-child { color: var(--ptext); background: var(--pacc-soft); }
.ls-list { display: grid; gap: 8px; }
.ls-row { display: flex; align-items: center; gap: 14px; padding: 14px; border: 1px solid var(--pborder); border-radius: 10px; background: var(--psurface); }
.ls-row.archived { opacity: .58; }
.ls-color { width: 10px; height: 38px; border-radius: 5px; flex: 0 0 auto; }
.ls-copy { min-width: 180px; flex: 1; }
.ls-title { font-weight: 600; display: flex; gap: 9px; align-items: baseline; }
.ls-title code { color: var(--ptext3); font-size: 10px; }
.ls-copy p { font-size: 12px; margin-top: 3px; }
.ls-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.ls-badges span, .ls-badge { font: 9px var(--pmono); text-transform: uppercase; letter-spacing: .06em; border: 1px solid var(--pborder); border-radius: 4px; padding: 2px 5px; color: var(--ptext3); }
.ls-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 3px; }
.ls-actions button { border: 1px solid var(--pborder); border-radius: 6px; font-size: 11px; padding: 5px 7px; }
.ls-actions button:disabled, .ls-footer button:disabled { opacity: .4; cursor: default; }
.danger { color: var(--pred) !important; }
.ls-add { border: 1px dashed var(--pacc-line); border-radius: 8px; margin-top: 12px; color: var(--pacc); }
.ls-message, .ls-error, .ls-empty { padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 12px; }
.ls-message { background: var(--pacc-soft); color: var(--pacc); }.ls-error { background: rgba(201,115,111,.1); color: var(--pred); }.ls-empty { color: var(--ptext2); }
.ls-scrim { position: fixed; inset: 0; background: rgba(4,7,12,.72); z-index: 50; display: grid; place-items: center; }
.ls-modal { width: 480px; max-width: calc(100vw - 40px); max-height: calc(100vh - 50px); overflow: auto; background: var(--psurface); border: 1px solid var(--pborder); border-radius: 14px; padding: 22px; box-shadow: 0 30px 80px rgba(0,0,0,.5); }
.ls-modal.wide { width: 620px; }
.ls-modal label { display: grid; gap: 5px; margin-top: 14px; color: var(--ptext2); font-size: 12px; }
.ls-modal input:not([type=radio]), .ls-modal textarea, .ls-modal select { width: 100%; background: var(--psurface2); border: 1px solid var(--pborder); border-radius: 7px; color: var(--ptext); padding: 8px; }
.ls-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.ls-modal fieldset { margin-top: 14px; border: 1px solid var(--pborder); border-radius: 8px; }.ls-modal fieldset label { display: flex; align-items: center; }
.ls-provenance { margin-top: 15px; padding: 12px; background: var(--psurface2); border-radius: 8px; font-size: 12px; }.ls-provenance ol { padding-left: 20px; color: var(--ptext3); }.ls-provenance li.effective { color: var(--pacc); font-weight: 600; }
.ls-footer { display: flex; gap: 8px; margin-top: 20px; }.ls-footer button { border: 1px solid var(--pborder); border-radius: 7px; }
</style>
