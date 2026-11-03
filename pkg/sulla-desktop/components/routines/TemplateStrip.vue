<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
      <button
        type="button"
        class="btn ghost"
        @click="$emit('export')"
      >
        Export
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
  (e: 'export'): void;
}>();
</script>

<style scoped lang="scss">
.strip {
  display: grid;
  grid-template-columns: 64px 1fr 170px auto;
  gap: 24px;
  align-items: center;
  padding: 22px 24px;
  background: linear-gradient(90deg, var(--bg-surface), var(--bg-surface));
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 12px;
  position: relative;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}
.strip:hover {
  border-color: var(--border-default);
  background: linear-gradient(90deg, var(--bg-surface), var(--bg-surface));
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
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 14px;
  border: 1px solid var(--border-default);
}
.icon.content  { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.research { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.planning { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.leads    { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.learning { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.ops      { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }
.icon.goals    { background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface)); }

.body { min-width: 0; }
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.cat {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.title {
  font-family: var(--font-display);
  font-style: italic;
  font-size: 21px;
  color: var(--text-primary);
  line-height: 1.15;
  margin-bottom: 4px;
}
.desc {
  font-family: var(--font-body);
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
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--border-default);
  color: var(--steel-200);
  background: var(--bg-surface);
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
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--steel-300);
  border-left: 1px solid var(--line);
  padding-left: 18px;
}
.metrics .big {
  font-family: var(--font-display);
  font-style: italic;
  font-size: 22px;
  color: var(--steel-100);
  line-height: 1;
}
.metrics .big small {
  font-family: var(--font-mono);
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
  color: var(--text-primary);
  font-weight: 700;
}

.cta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.btn {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
  color: var(--steel-100);
  background: var(--bg-surface);
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s, color 0.18s;
  backdrop-filter: blur(6px);
  white-space: nowrap;
}
.btn:hover {
  border-color: var(--border-default);
  color: var(--text-primary);
  background: var(--bg-surface);
}
.btn.primary {
  border-color: var(--border-default);
  color: var(--text-primary);
  background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface));
  box-shadow: 0 8px 22px var(--border-subtle), 0 0 14px var(--border-subtle);
}
.btn.primary:hover {
  background: linear-gradient(135deg, var(--bg-surface), var(--bg-surface));
  border-color: var(--border-default);
}
.btn.ghost { background: transparent; }

.strip {
  grid-template-columns: 52px minmax(0, 1fr) 150px auto;
  gap: 18px;
  margin-bottom: 10px;
  padding: 16px 18px;
  border-color: var(--border-subtle);
  border-radius: 17px;
  background: color-mix(in srgb, var(--bg-surface) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  transition: transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1), border-color 0.2s, background 0.2s, box-shadow 0.2s;
}

.strip:hover {
  border-color: color-mix(in srgb, var(--accent-hover) 25%, transparent);
  background: color-mix(in srgb, var(--accent) 7.5%, transparent);
  transform: translateY(-2px);
  box-shadow: 0 14px 34px var(--border-subtle);
}

.strip::before {
  left: -1px;
  top: 14px;
  bottom: 14px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 60%, transparent);
}

.icon,
.icon[class] {
  width: 46px;
  height: 46px;
  border-color: color-mix(in srgb, var(--accent-hover) 24%, transparent);
  border-radius: 13px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent-hover) 30%, transparent), color-mix(in srgb, var(--accent) 10%, transparent));
}

.title,
.metrics .big {
  font-family: var(--font-display), Georgia, serif;
  font-style: normal;
  color: var(--text-primary);
}

.chip {
  border-color: color-mix(in srgb, var(--border-default) calc(r + 62) calc(g + 16) calc(b + 16)) 9%, transparent);
  border-radius: 9px;
  color: var(--text-dim);
  background: var(--bg-surface) calc(r + 2) calc(g + 3) calc(b + 2) / 0.5);
}

.btn {
  border-radius: 16px;
}

.btn.primary {
  border-color: color-mix(in srgb, var(--accent-hover) 42%, transparent);
  background: linear-gradient(180deg, var(--accent-hover), var(--accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 20%, transparent);
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
.strip:hover {
  box-shadow: 0 14px 34px color-mix(in srgb, var(--text-primary) 8%, transparent);
}
</style>
