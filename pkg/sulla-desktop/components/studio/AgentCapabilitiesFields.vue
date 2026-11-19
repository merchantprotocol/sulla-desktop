<!--
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<template>
  <section
    class="space-y-4"
    aria-labelledby="agent-capabilities-heading"
  >
    <div>
      <h3
        id="agent-capabilities-heading"
        class="text-sm font-semibold text-content"
      >
        Capabilities
      </h3>
      <p class="mt-1 text-xs text-content-muted">
        References use the current local catalogs when available. Unlisted
        saved references stay attached and are shown as preserved values.
      </p>
    </div>

    <div
      v-if="error"
      class="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
      role="status"
    >
      {{ error }} Catalog refresh did not change the saved selections.
      <button
        type="button"
        class="ml-2 underline"
        @click="loadCatalogs"
      >
        Retry
      </button>
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <div class="rounded border border-edge p-3">
        <div class="mb-2 flex items-baseline justify-between gap-3">
          <div>
            <h4 class="text-sm font-semibold text-content">
              Tools
            </h4>
            <p class="text-xs text-content-muted">
              Empty keeps the existing default-tools behavior.
            </p>
          </div>
          <span class="text-xs text-content-muted">{{
            allowedTools.length
              ? `${allowedTools.length} selected`
              : 'Default tools'
          }}</span>
        </div>
        <div
          v-if="loading"
          class="text-sm text-content-muted"
        >
          Loading tool catalog…
        </div>
        <div
          v-else
          class="max-h-72 space-y-3 overflow-auto pr-1"
        >
          <div
            v-for="category in toolCategories"
            :key="category.category"
          >
            <div
              class="mb-1 text-xs font-medium uppercase tracking-wide text-content-muted"
            >
              {{ category.category }}
            </div>
            <label
              v-for="tool in category.tools"
              :key="tool.name"
              class="flex items-start gap-2 py-1 text-sm"
            >
              <input
                type="checkbox"
                :checked="allowedTools.includes(tool.name)"
                @change="setTool(tool.name, checked($event))"
              >
              <span>
                <span class="block text-content">{{ tool.name }}</span>
                <span class="block text-xs text-content-muted">{{
                  tool.description
                }}</span>
              </span>
            </label>
          </div>
          <label
            v-for="tool in missingTools"
            :key="`missing-tool-${tool}`"
            class="flex items-start gap-2 py-1 text-sm"
          >
            <input
              type="checkbox"
              checked
              @change="setTool(tool, checked($event))"
            >
            <span class="text-amber-200">{{ tool }} · not listed (preserved)</span>
          </label>
          <p
            v-if="catalogReady && !toolCategories.length && !missingTools.length"
            class="text-sm text-content-muted"
          >
            No tool catalog entries were returned.
          </p>
          <p
            v-else-if="!catalogReady"
            class="text-sm text-content-muted"
          >
            Tool catalog unavailable; saved references are preserved.
          </p>
        </div>
      </div>

      <div class="rounded border border-edge p-3">
        <div class="mb-2 flex items-baseline justify-between gap-3">
          <div>
            <h4 class="text-sm font-semibold text-content">
              Skills
            </h4>
            <p class="text-xs text-content-muted">
              No explicit skills are assigned when this list is empty.
            </p>
          </div>
          <span class="text-xs text-content-muted">{{
            skillRefs.length ? `${skillRefs.length} selected` : 'No explicit skills'
          }}</span>
        </div>
        <div
          v-if="loading"
          class="text-sm text-content-muted"
        >
          Loading skill catalog…
        </div>
        <div
          v-else
          class="max-h-72 space-y-2 overflow-auto pr-1"
        >
          <label
            v-for="skill in skills"
            :key="skill.slug"
            class="flex items-start gap-2 py-1 text-sm"
          >
            <input
              type="checkbox"
              :checked="skillRefs.includes(skill.slug)"
              @change="setSkill(skill.slug, checked($event))"
            >
            <span>
              <span class="block text-content">{{ skill.name }}
                <span class="font-mono text-xs text-content-muted">{{
                  skill.slug
                }}</span></span>
              <span class="block text-xs text-content-muted">{{
                skill.description
              }}</span>
            </span>
          </label>
          <label
            v-for="skill in missingSkills"
            :key="`missing-skill-${skill}`"
            class="flex items-start gap-2 py-1 text-sm"
          >
            <input
              type="checkbox"
              checked
              @change="setSkill(skill, checked($event))"
            >
            <span class="text-amber-200">{{ skill }} · not listed (preserved)</span>
          </label>
          <p
            v-if="catalogReady && !skills.length && !missingSkills.length"
            class="text-sm text-content-muted"
          >
            No skill catalog entries were returned.
          </p>
          <p
            v-else-if="!catalogReady"
            class="text-sm text-content-muted"
          >
            Skill catalog unavailable; saved references are preserved.
          </p>
        </div>
      </div>
    </div>

    <label class="block space-y-1 text-sm">
      <span class="font-medium text-content">Routine references</span>
      <textarea
        :value="routineText"
        class="min-h-20 w-full rounded border border-edge bg-surface px-3 py-2 font-mono text-sm"
        rows="3"
        placeholder="One existing routine reference per line"
        @input="setRoutines($event)"
      />
      <span class="text-xs text-content-muted">References not returned by a catalog are preserved verbatim.</span>
    </label>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type SkillOption = Awaited<
  ReturnType<typeof ipcRenderer.invoke<'library-list-skills'>>
>[number];
type ToolCategory = Awaited<
  ReturnType<typeof ipcRenderer.invoke<'tools-list-by-category'>>
>[number];

const props = defineProps<{
  allowedTools: string[];
  skillRefs:    string[];
  routineRefs:  string[];
}>();

const emit = defineEmits<{
  'update:allowedTools': [value: string[]];
  'update:skillRefs':    [value: string[]];
  'update:routineRefs':  [value: string[]];
}>();

const skills = ref<SkillOption[]>([]);
const toolCategories = ref<ToolCategory[]>([]);
const loading = ref(false);
const error = ref('');
const catalogReady = ref(false);
const allowedTools = computed(() => props.allowedTools ?? []);
const skillRefs = computed(() => props.skillRefs ?? []);
// The textarea keeps the raw typed text (blank or trailing lines while typing);
// only an outside change to the saved list replaces it.
const routineText = ref((props.routineRefs ?? []).join('\n'));
watch(() => props.routineRefs ?? [], (refs) => {
  if (JSON.stringify(parseRoutines(routineText.value)) !== JSON.stringify(refs)) routineText.value = refs.join('\n');
});
const knownTools = computed(
  () =>
    new Set(
      toolCategories.value.flatMap((category) =>
        category.tools.map((tool) => tool.name),
      ),
    ),
);
const knownSkills = computed(
  () => new Set(skills.value.map((skill) => skill.slug)),
);
const missingTools = computed(() =>
  catalogReady.value
    ? allowedTools.value.filter((tool) => !knownTools.value.has(tool))
    : [],
);
const missingSkills = computed(() =>
  catalogReady.value
    ? skillRefs.value.filter((skill) => !knownSkills.value.has(skill))
    : [],
);

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}

function toggle(
  values: readonly string[],
  value: string,
  selected: boolean,
): string[] {
  const next = values.filter((item) => item !== value);
  if (selected) next.push(value);
  return next;
}

function setTool(tool: string, selected: boolean): void {
  emit('update:allowedTools', toggle(allowedTools.value, tool, selected));
}

function setSkill(skill: string, selected: boolean): void {
  emit('update:skillRefs', toggle(skillRefs.value, skill, selected));
}

function parseRoutines(text: string): string[] {
  return text
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

function setRoutines(event: Event): void {
  routineText.value = (event.target as HTMLTextAreaElement).value;
  emit('update:routineRefs', parseRoutines(routineText.value));
}

async function loadCatalogs(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [nextSkills, nextTools] = await Promise.all([
      ipcRenderer.invoke('library-list-skills'),
      ipcRenderer.invoke('tools-list-by-category'),
    ]);
    skills.value = nextSkills;
    toolCategories.value = nextTools;
    catalogReady.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(loadCatalogs);
</script>
