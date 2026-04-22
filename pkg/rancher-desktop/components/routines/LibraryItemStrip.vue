<template>
  <div
    class="strip"
    :class="`kind-${ kind }`"
  >
    <div
      class="icon"
      :class="`kind-${ kind }`"
    >
      {{ initials }}
    </div>

    <div class="body">
      <div class="top">
        <span
          class="kind-badge"
          :class="`kind-${ kind }`"
        >{{ kindLabel }}</span>
        <span
          v-if="item.version"
          class="chip"
        >v{{ item.version }}</span>
        <span class="slug">{{ item.slug }}</span>
      </div>
      <div class="title">
        {{ item.name }}
      </div>
      <div
        v-if="item.description"
        class="desc"
      >
        {{ item.description }}
      </div>
      <div
        v-if="item.meta.length > 0"
        class="meta"
      >
        <span
          v-for="m in item.meta"
          :key="m.label"
          class="chip"
        >
          <span class="ml">{{ m.label }}</span>
          <span class="mv">{{ m.value }}</span>
        </span>
      </div>
    </div>

    <div class="cta">
      <button
        v-if="primaryLabel"
        type="button"
        class="btn primary"
        @click="$emit('primary')"
      >
        {{ primaryLabel }}
      </button>
      <button
        type="button"
        class="btn ghost"
        @click="$emit('view')"
      >
        View
      </button>
      <button
        type="button"
        class="btn ghost"
        @click="$emit('reveal')"
      >
        Reveal
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { LibraryItem, LibraryKind } from '@pkg/composables/useLibrary';

const props = defineProps<{
  kind:          LibraryKind;
  item:          LibraryItem;
  primaryLabel?: string;
}>();

defineEmits<{
  (e: 'primary'): void;
  (e: 'view'): void;
  (e: 'reveal'): void;
}>();

const KIND_LABELS: Record<LibraryKind, string> = {
  routines:  'Routine',
  skills:    'Skill',
  functions: 'Function',
  recipes:   'Recipe',
};

const kindLabel = computed(() => KIND_LABELS[props.kind]);

const initials = computed(() => {
  const source = props.item.name || props.item.slug || '??';
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
});
</script>

<style scoped lang="scss">
.strip {
  display: grid;
  grid-template-columns: 64px 1fr auto;
  gap: 24px;
  align-items: center;
  padding: 20px 24px;
  background: linear-gradient(90deg, rgba(18, 28, 48, 0.7), rgba(10, 18, 36, 0.4));
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 12px;
  position: relative;
  transition: border-color 0.18s, background 0.18s;
}
.strip:hover {
  border-color: rgba(140, 172, 201, 0.5);
  background: linear-gradient(90deg, rgba(26, 40, 66, 0.82), rgba(16, 26, 46, 0.55));
}

.icon {
  width: 56px; height: 56px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: white;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.icon.kind-routines  { background: linear-gradient(135deg, #2c4871, #4a6fa5); }
.icon.kind-skills    { background: linear-gradient(135deg, #d97706, #f59e0b); }
.icon.kind-functions { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.icon.kind-recipes   { background: linear-gradient(135deg, #a21caf, #c026d3); }

.body { min-width: 0; }
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
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
.kind-badge.kind-routines  { background: rgba(74, 111, 165, 0.35); border-color: rgba(74, 111, 165, 0.6); }
.kind-badge.kind-skills    { background: rgba(245, 158, 11, 0.35); border-color: rgba(245, 158, 11, 0.6); }
.kind-badge.kind-functions { background: rgba(6, 182, 212, 0.35);  border-color: rgba(6, 182, 212, 0.6); }
.kind-badge.kind-recipes   { background: rgba(192, 38, 211, 0.35); border-color: rgba(192, 38, 211, 0.6); }

.slug {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-400);
}

.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 19px;
  color: white;
  line-height: 1.15;
  margin-bottom: 4px;
}
.desc {
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--steel-200);
  line-height: 1.5;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
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
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.chip .ml { color: var(--steel-400); }
.chip .mv { color: var(--steel-100); }

.cta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 140px;
}
.cta .btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 8px 14px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.cta .btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}
.cta .btn.primary:hover { filter: brightness(1.15); }
.cta .btn.ghost {
  background: transparent;
  color: var(--steel-200);
  border-color: rgba(168, 192, 220, 0.3);
}
.cta .btn.ghost:hover { border-color: var(--steel-300); color: white; }
</style>
