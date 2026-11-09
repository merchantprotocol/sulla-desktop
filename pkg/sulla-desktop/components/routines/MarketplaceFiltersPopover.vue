<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <Transition name="popover">
    <div
      v-if="open"
      ref="panel"
      class="filter-popover"
      @keydown.esc.stop="$emit('close')"
    >
      <section
        v-for="facet in facets"
        :key="facet.key"
      >
        <h4>{{ facet.label }}</h4><label
          v-for="option in facet.options"
          :key="option.value"
          :class="{ dimmed: option.count === 0 }"
        ><input
          type="checkbox"
          :checked="selected(facet.key, option.value)"
          @change="toggle(facet.key, option.value)"
        ><span>{{ option.label }}</span><small>{{ option.count }}</small></label>
      </section><button
        class="apply"
        type="button"
        @click="$emit('apply')"
      >
        Show {{ resultCount }} use cases
      </button>
    </div>
  </Transition>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import type { MarketplaceFacet, MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';
const props = defineProps<{ facets: MarketplaceFacet[]; state: MarketplaceSearchState; resultCount: number; open: boolean }>();
const emit = defineEmits<{ 'update:state': [state: MarketplaceSearchState]; apply: []; close: [] }>();
const panel = ref<HTMLElement>();
type FacetField = 'topics' | 'kinds' | 'media' | 'price' | 'length' | 'apps' | 'approval';
const fields: Record<string, FacetField> = { topics: 'topics', kinds: 'kinds', media: 'media', price: 'price', length: 'length', apps: 'apps', approval: 'approval' };
function values(key: string): string[] { return props.state[fields[key]] ?? [] }
function selected(key: string, value: string): boolean { return values(key).includes(value) }
function toggle(key: string, value: string): void {
  const field = fields[key];
  if (!field) return;
  const current = props.state[field];
  emit('update:state', { ...props.state, [field]: current.includes(value) ? current.filter(item => item !== value) : [...current, value] });
}
function outside(event: PointerEvent): void {
  if (props.open && panel.value && !panel.value.contains(event.target as Node)) emit('close');
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>
<style scoped>
.filter-popover{position:absolute;z-index:8;top:calc(100% + 12px);right:0;width:min(370px,92vw);max-height:70vh;overflow:auto;padding:20px;background:var(--bg-surface,#fff);color:var(--text-primary,var(--text,#222));border:1px solid var(--border-default,var(--border,#ddd));border-radius:18px;box-shadow:0 16px 44px #0002}.filter-popover section{padding:0 0 14px}.filter-popover h4{margin:0 0 8px;font-size:13px}.filter-popover label{display:flex;align-items:center;gap:10px;padding:7px 2px;cursor:pointer}.filter-popover input{accent-color:var(--accent,#397f99)}.filter-popover small{margin-left:auto;color:var(--text-secondary,var(--text-muted,#666))}.filter-popover label.dimmed{opacity:.45}.apply{width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent,#397f99);color:white;font-weight:600;cursor:pointer}.popover-enter-active,.popover-leave-active{transition:opacity .15s,transform .15s}.popover-enter-from,.popover-leave-to{opacity:0;transform:translateY(-5px)}@media(prefers-reduced-motion:reduce){.popover-enter-active,.popover-leave-active{transition:none}}
</style>
