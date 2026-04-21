<template>
  <div
    class="strip"
    @click="$emit('use')"
  >
    <div
      class="icon"
      :class="template.category"
    >
      {{ template.initials }}
    </div>

    <div class="body">
      <div class="top">
        <span class="cat">{{ template.section }} · {{ template.category }}</span>
        <span class="chip">v{{ template.version }}</span>
        <span
          v-if="template.runtime"
          class="chip"
        >{{ template.runtime }}</span>
      </div>
      <div class="title">
        {{ template.name }}
      </div>
      <div class="desc">
        {{ template.description }}
      </div>
      <div class="meta">
        <span
          v-for="tag in template.tags"
          :key="tag"
          class="chip"
        >#{{ tag }}</span>
      </div>
    </div>

    <div class="metrics">
      <div class="big">
        {{ template.inputCount }}<small>in</small>
      </div>
      <div class="row">
        <span><b>{{ template.outputCount }}</b> out</span><span>{{ template.permissions }}</span>
      </div>
      <div class="row">
        <span>{{ template.slug }}</span>
      </div>
    </div>

    <div
      class="cta"
      @click.stop
    >
      <button
        type="button"
        class="btn primary"
        @click="$emit('use')"
      >
        Use this
      </button>
      <button
        type="button"
        class="btn ghost"
        @click="$emit('preview')"
      >
        Preview
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TemplateSummary } from '@pkg/types/routines';

defineProps<{
  template: TemplateSummary;
}>();

defineEmits<{
  (e: 'use'): void;
  (e: 'preview'): void;
}>();
</script>

<style scoped lang="scss">
.strip {
  display: grid;
  grid-template-columns: 64px 1fr 170px auto;
  gap: 24px;
  align-items: center;
  padding: 22px 24px;
  background: linear-gradient(90deg, rgba(18, 28, 48, 0.7), rgba(10, 18, 36, 0.4));
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 12px;
  position: relative;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}
.strip:hover {
  border-color: rgba(140, 172, 201, 0.5);
  background: linear-gradient(90deg, rgba(26, 40, 66, 0.82), rgba(16, 26, 46, 0.55));
}
.strip::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, transparent, var(--steel-300), transparent);
  opacity: 0;
  transition: opacity 0.18s;
}
.strip:hover::before { opacity: 0.8; }

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
.icon.content  { background: linear-gradient(135deg, #2c4871, #4a6fa5); }
.icon.research { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.icon.planning { background: linear-gradient(135deg, #d97706, #f59e0b); }
.icon.leads    { background: linear-gradient(135deg, #059669, #10b981); }
.icon.learning { background: linear-gradient(135deg, #7c3aed, #a78bfa); }
.icon.ops      { background: linear-gradient(135deg, #475569, #64748b); }
.icon.goals    { background: linear-gradient(135deg, #be123c, #e11d48); }

.body { min-width: 0; }
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.cat {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 21px;
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

.metrics {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: right;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--steel-300);
  border-left: 1px solid var(--line);
  padding-left: 18px;
}
.metrics .big {
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: var(--steel-100);
  line-height: 1;
}
.metrics .big small {
  font-family: var(--mono);
  font-style: normal;
  font-size: 10px;
  color: var(--steel-400);
  margin-left: 3px;
}
.metrics .row {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
.metrics .row span b {
  color: white;
  font-weight: 700;
}

.cta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.btn {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 4px;
  border: 1px solid rgba(168, 192, 220, 0.3);
  color: var(--steel-100);
  background: rgba(20, 30, 54, 0.55);
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s, color 0.18s;
  backdrop-filter: blur(6px);
  white-space: nowrap;
}
.btn:hover {
  border-color: rgba(196, 212, 230, 0.6);
  color: white;
  background: rgba(74, 111, 165, 0.16);
}
.btn.primary {
  border-color: rgba(140, 172, 201, 0.6);
  color: white;
  background: linear-gradient(135deg, rgba(74, 111, 165, 0.72), rgba(44, 72, 113, 0.82));
  box-shadow: 0 8px 22px rgba(74, 111, 165, 0.38), 0 0 14px rgba(74, 111, 165, 0.22);
}
.btn.primary:hover {
  background: linear-gradient(135deg, rgba(90, 130, 185, 0.9), rgba(58, 90, 140, 0.9));
  border-color: rgba(196, 212, 230, 0.75);
}
.btn.ghost { background: transparent; }
</style>
