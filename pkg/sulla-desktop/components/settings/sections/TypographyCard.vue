<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed, ref } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefRange from '../PrefRange.vue';
import PrefRow from '../PrefRow.vue';

import { useTypography } from '@pkg/composables/useTypography';
import {
  CODE_SIZE_RANGE, COLOR_PRESETS, emptyTypography, FONT_PRESETS, HEADING_SCALE_RANGE, isTypographyDefault,
  LEADING_RANGE, SIZE_RANGES,
  type BasicSectionId, type ColorPreset, type FontPreset, type TypographySectionId, type TypographySettings,
} from '@pkg/config/typography';

const { typography, setTypography } = useTypography();

const SECTIONS: { id: TypographySectionId, label: string, hint: string }[] = [
  { id: 'menus', label: 'Menus', hint: 'Right-click menus in chat and Files.' },
  { id: 'tabs', label: 'Top tabs', hint: 'Tab names in the bar across the top of the window.' },
  { id: 'sidebar', label: 'Sidebar', hint: 'Section lists down the left side of Files and Preferences.' },
  { id: 'output', label: 'Text output', hint: 'Message text in chat. Color applies to Sulla\'s replies; your messages keep their bubble colors.' },
  { id: 'formatting', label: 'Formatting', hint: 'Headings, code and links inside Sulla\'s replies.' },
];

const active = ref<TypographySectionId>('output');
const activeInfo = computed(() => SECTIONS.find(s => s.id === active.value)!);
const basicSection = computed<BasicSectionId | null>(() => active.value === 'formatting' ? null : active.value);

const fonts = Object.entries(FONT_PRESETS).map(([value, preset]) => ({ value: value as FontPreset, label: preset.label }));
const colors = Object.entries(COLOR_PRESETS).map(([value, preset]) => ({ value: value as ColorPreset, label: preset.label, token: preset.token }));

const sectionIsDefault = computed(() => Object.keys(typography.value[active.value]).length === 0);
const allDefault = computed(() => isTypographyDefault(typography.value));

function clone(): TypographySettings {
  return JSON.parse(JSON.stringify(typography.value));
}

/** Writes one field of one section; `undefined` returns it to the theme default. */
function update(section: TypographySectionId, field: string, value: string | number | undefined): void {
  const next = clone();
  const target = next[section] as Record<string, unknown>;

  if (value === undefined || value === '') delete target[field]; else target[field] = value;
  setTypography(next);
}

function field(section: TypographySectionId, name: string): any {
  return (typography.value[section] as Record<string, unknown>)[name];
}

function onSelect(section: TypographySectionId, name: string, event: Event): void {
  update(section, name, (event.target as HTMLSelectElement).value || undefined);
}

function resetSection(): void {
  setTypography({ ...clone(), [active.value]: {} });
}

function resetAll(): void {
  setTypography(emptyTypography());
}

const px = (value: number) => `${ value } px`;
const times = (value: number) => `${ value.toFixed(2) }×`;

/** Preview text uses the same variables the app does, so it matches what changes. */
const previewStyle = computed(() => {
  const section = basicSection.value;

  if (!section) return {};

  return {
    fontFamily: `var(--type-${ section }-font, inherit)`,
    fontSize:   `var(--type-${ section }-size, ${ SIZE_RANGES[section].base }px)`,
    color:      `var(--type-${ section }-color, var(--text))`,
    lineHeight: section === 'output' ? `var(--type-output-leading, ${ LEADING_RANGE.base })` : '1.4',
  };
});
</script>

<template>
  <PrefCard
    title="Typography"
    subtitle="Fonts, sizes and colors for each part of the app."
  >
    <template #actions>
      <button
        type="button"
        class="btn sm ghost"
        :disabled="allDefault"
        @click="resetAll"
      >
        Reset all
      </button>
    </template>

    <PrefRow title="Part of the app">
      <div
        class="seg typo-sections"
        role="tablist"
        aria-label="Typography section"
      >
        <button
          v-for="section in SECTIONS"
          :key="section.id"
          type="button"
          role="tab"
          :aria-selected="active === section.id"
          :class="{ on: active === section.id }"
          @click="active = section.id"
        >
          {{ section.label }}
        </button>
      </div>
    </PrefRow>
    <p class="typo-hint">
      {{ activeInfo.hint }}
    </p>

    <template v-if="basicSection">
      <PrefRow title="Font">
        <select
          class="sel"
          aria-label="Font"
          :value="field(basicSection, 'font') ?? ''"
          @change="onSelect(basicSection, 'font', $event)"
        >
          <option value="">
            Theme default
          </option>
          <option
            v-for="font in fonts"
            :key="font.value"
            :value="font.value"
          >
            {{ font.label }}
          </option>
        </select>
      </PrefRow>

      <PrefRow
        title="Size"
        :subtitle="field(basicSection, 'size') === undefined ? 'Theme default' : undefined"
      >
        <PrefRange
          :model-value="field(basicSection, 'size') ?? SIZE_RANGES[basicSection].base"
          :min="SIZE_RANGES[basicSection].min"
          :max="SIZE_RANGES[basicSection].max"
          :step="SIZE_RANGES[basicSection].step"
          :format="px"
          label="Size"
          @change="update(basicSection, 'size', $event)"
        />
      </PrefRow>

      <PrefRow
        v-if="basicSection === 'output'"
        title="Line spacing"
        :subtitle="field('output', 'leading') === undefined ? 'Theme default' : undefined"
      >
        <PrefRange
          :model-value="field('output', 'leading') ?? LEADING_RANGE.base"
          :min="LEADING_RANGE.min"
          :max="LEADING_RANGE.max"
          :step="LEADING_RANGE.step"
          :format="times"
          label="Line spacing"
          @change="update('output', 'leading', $event)"
        />
      </PrefRow>

      <PrefRow title="Color">
        <div
          class="typo-swatches"
          role="radiogroup"
          aria-label="Color"
        >
          <button
            type="button"
            role="radio"
            class="typo-swatch default"
            :aria-checked="!field(basicSection, 'color')"
            :class="{ on: !field(basicSection, 'color') }"
            title="Theme default"
            aria-label="Theme default"
            @click="update(basicSection, 'color', undefined)"
          />
          <button
            v-for="color in colors"
            :key="color.value"
            type="button"
            role="radio"
            class="typo-swatch"
            :style="{ background: color.token }"
            :aria-checked="field(basicSection, 'color') === color.value"
            :class="{ on: field(basicSection, 'color') === color.value }"
            :title="color.label"
            :aria-label="color.label"
            @click="update(basicSection, 'color', color.value)"
          />
        </div>
      </PrefRow>
    </template>

    <template v-else>
      <PrefRow
        title="Heading size"
        :subtitle="field('formatting', 'headingScale') === undefined ? 'Theme default' : undefined"
      >
        <PrefRange
          :model-value="field('formatting', 'headingScale') ?? HEADING_SCALE_RANGE.base"
          :min="HEADING_SCALE_RANGE.min"
          :max="HEADING_SCALE_RANGE.max"
          :step="HEADING_SCALE_RANGE.step"
          :format="times"
          label="Heading size"
          @change="update('formatting', 'headingScale', $event)"
        />
      </PrefRow>
      <PrefRow
        v-for="row in [{ name: 'headingColor', title: 'Heading color' }, { name: 'linkColor', title: 'Link color' }]"
        :key="row.name"
        :title="row.title"
      >
        <div
          class="typo-swatches"
          role="radiogroup"
          :aria-label="row.title"
        >
          <button
            type="button"
            role="radio"
            class="typo-swatch default"
            :aria-checked="!field('formatting', row.name)"
            :class="{ on: !field('formatting', row.name) }"
            title="Theme default"
            aria-label="Theme default"
            @click="update('formatting', row.name, undefined)"
          />
          <button
            v-for="color in colors"
            :key="color.value"
            type="button"
            role="radio"
            class="typo-swatch"
            :style="{ background: color.token }"
            :aria-checked="field('formatting', row.name) === color.value"
            :class="{ on: field('formatting', row.name) === color.value }"
            :title="color.label"
            :aria-label="color.label"
            @click="update('formatting', row.name, color.value)"
          />
        </div>
      </PrefRow>
      <PrefRow title="Code font">
        <select
          class="sel"
          aria-label="Code font"
          :value="field('formatting', 'codeFont') ?? ''"
          @change="onSelect('formatting', 'codeFont', $event)"
        >
          <option value="">
            Theme default
          </option>
          <option
            v-for="font in fonts"
            :key="font.value"
            :value="font.value"
          >
            {{ font.label }}
          </option>
        </select>
      </PrefRow>
      <PrefRow
        title="Code size"
        :subtitle="field('formatting', 'codeSize') === undefined ? 'Theme default' : undefined"
      >
        <PrefRange
          :model-value="field('formatting', 'codeSize') ?? CODE_SIZE_RANGE.base"
          :min="CODE_SIZE_RANGE.min"
          :max="CODE_SIZE_RANGE.max"
          :step="CODE_SIZE_RANGE.step"
          :format="px"
          label="Code size"
          @change="update('formatting', 'codeSize', $event)"
        />
      </PrefRow>
    </template>

    <div
      class="typo-preview"
      aria-label="Preview"
    >
      <p
        v-if="basicSection"
        :style="previewStyle"
      >
        The quick brown fox jumps over the lazy dog. 0123456789
      </p>
      <div
        v-else
        class="typo-preview-format"
      >
        <h3>Heading example</h3>
        <p>
          Run <code>yarn build</code> then read the <a
            href="#"
            @click.prevent
          >release notes</a>.
        </p>
      </div>
      <button
        type="button"
        class="btn sm ghost"
        :disabled="sectionIsDefault"
        @click="resetSection"
      >
        Reset {{ activeInfo.label.toLowerCase() }}
      </button>
    </div>
  </PrefCard>
</template>

<style scoped>
.typo-sections { flex-wrap: wrap; }
.typo-hint { margin: -2px 0 8px; padding: 0 18px; font-size: 12px; color: var(--muted); }
.typo-swatches { display: flex; gap: 8px; }
.typo-swatch {
  width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 50%; cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--line-2);
}
.typo-swatch.default {
  background: conic-gradient(var(--text) 0 50%, var(--muted) 0 100%);
}
.typo-swatch.on { box-shadow: 0 0 0 2px var(--card-solid), 0 0 0 4px var(--accent); }
.typo-swatch:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.typo-preview {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin: 10px 18px 16px; padding: 14px 16px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
}
.typo-preview p { margin: 0; }
.typo-preview-format h3 {
  margin: 0 0 6px;
  font-size: calc(1.17em * var(--type-heading-scale, 1));
  color: var(--type-heading-color, var(--text));
}
.typo-preview-format p { color: var(--text); }
.typo-preview-format code {
  padding: 1px 6px; border-radius: 5px; background: var(--line);
  font-family: var(--type-code-font, var(--mono, monospace));
  font-size: var(--type-code-size, 12.5px);
}
.typo-preview-format a { color: var(--type-link-color, var(--accent-2)); }
</style>
