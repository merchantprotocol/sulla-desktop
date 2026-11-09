<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside class="filter-rail">
    <form
      class="search"
      role="search"
      @submit.prevent="submit"
    >
      <UseCaseIcon name="search" />
      <input
        v-model="query"
        type="search"
        aria-label="Search use cases"
        placeholder="Search use cases"
        @input="scheduleSearch"
      >
      <button
        v-if="query"
        type="button"
        aria-label="Clear search"
        @click="query = ''; submit()"
      >
        ×
      </button>
    </form>
    <div class="rail-head">
      <h2>Filters</h2><button
        type="button"
        :disabled="!hasFilters"
        @click="clear"
      >
        Clear all
      </button>
    </div>
    <section
      v-for="facet in facets"
      :key="facet.key"
      class="facet"
    >
      <button
        class="facet-title"
        type="button"
        :aria-expanded="!collapsed[facet.key]"
        @click="toggleGroup(facet.key)"
      >
        {{ facet.label }}<span>{{ collapsed[facet.key] ? '+' : '−' }}</span>
      </button>
      <div
        v-if="!collapsed[facet.key]"
        class="options"
      >
        <label
          v-for="option in visibleOptions(facet)"
          :key="option.value"
          :class="{ zero: option.count === 0 }"
        >
          <input
            type="checkbox"
            :checked="selected(facet.key, option.value)"
            @change="toggle(facet.key, option.value)"
          >
          <span>{{ option.label }}</span><small>{{ option.count }}</small>
        </label>
        <button
          v-if="facet.options.length > 6"
          class="more"
          type="button"
          @click="toggleMore(facet.key)"
        >
          {{ expanded[facet.key] ? 'Show less' : `Show ${facet.options.length - 6} more` }}
        </button>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import UseCaseIcon from './UseCaseIcon.vue';

import type { MarketplaceFacet, MarketplaceSearchState } from '../../composables/MarketplaceSearchService';

const props = defineProps<{ facets: MarketplaceFacet[]; state: MarketplaceSearchState }>();
const emit = defineEmits<{ 'update:state': [state: MarketplaceSearchState] }>();
const query = ref(props.state.q);
const collapsed = ref<Record<string, boolean>>({});
const expanded = ref<Record<string, boolean>>({});
let timer: ReturnType<typeof setTimeout> | undefined;
const hasFilters = computed(() => Boolean(props.state.q || props.state.topics.length || props.state.kinds.length || props.state.media.length));
watch(() => props.state.q, value => { query.value = value });
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
function submit() { if (timer) clearTimeout(timer); emit('update:state', { ...props.state, q: query.value }) }
function scheduleSearch() { if (timer) clearTimeout(timer); timer = setTimeout(submit, 250) }
function clear() { query.value = ''; emit('update:state', { ...props.state, q: '', topics: [], kinds: [], media: [] }) }
function selected(key: string, value: string) { return (props.state[key as 'topics' | 'kinds' | 'media'] ?? []).includes(value) }
function toggle(key: string, value: string) {
  const field = key as 'topics' | 'kinds' | 'media';
  const values = props.state[field] ?? [];
  emit('update:state', { ...props.state, [field]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] });
}
function toggleGroup(key: string) { collapsed.value[key] = !collapsed.value[key] }
function toggleMore(key: string) { expanded.value[key] = !expanded.value[key] }
function visibleOptions(facet: MarketplaceFacet) { return expanded.value[facet.key] ? facet.options : facet.options.slice(0, 6) }
</script>

<style scoped>
.filter-rail{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto;padding:2px 6px 24px 2px;scrollbar-width:thin;color:var(--text)}
.search{height:44px;display:flex;align-items:center;gap:9px;padding:0 10px 0 13px;border-radius:14px;box-shadow:inset 0 0 0 1px var(--border);background:var(--surface-1)}.search :deep(svg){width:17px;height:17px;color:var(--text-muted)}.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit}.search button{border:0;background:none;color:var(--text-muted);font-size:20px;cursor:pointer}
.rail-head{display:flex;align-items:center;justify-content:space-between;margin:24px 0 8px}.rail-head h2{font-size:15px;font-weight:600;margin:0}.rail-head button,.more{border:0;background:none;color:var(--accent);font-size:13px;cursor:pointer}.rail-head button:disabled{opacity:.45;cursor:default}
.facet{border-top:1px solid var(--border-muted);padding:13px 0 8px}.facet-title{width:100%;display:flex;justify-content:space-between;border:0;background:none;padding:2px 0 8px;text-align:left;font-weight:600;color:inherit;cursor:pointer}.facet-title span{color:var(--text-muted)}.options label{display:flex;align-items:center;gap:10px;padding:6px;border-radius:8px;color:var(--text-muted);cursor:pointer}.options label:hover{background:var(--surface-2)}.options input{accent-color:var(--accent)}.options label small{margin-left:auto;color:var(--text-dim);font-size:12px}.options label.zero{opacity:.45}.more{padding:7px 6px}
</style>
