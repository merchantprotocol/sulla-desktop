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
<script setup lang="ts">import { onBeforeUnmount, onMounted, ref } from 'vue';

import type { MarketplaceFacet, MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService'; const props = defineProps<{ facets: MarketplaceFacet[]; state: MarketplaceSearchState; resultCount: number; open: boolean }>(); const emit = defineEmits<{ 'update:state': [state:MarketplaceSearchState]; apply: []; close: [] }>(); const panel = ref<HTMLElement>(); function selected(key:string, value:string) { const field = key as 'topics' | 'kinds' | 'media'; return props.state[field].includes(value) } function toggle(key:string, value:string) { const field = key as 'topics' | 'kinds' | 'media'; const values = props.state[field]; emit('update:state', { ...props.state, [field]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] }) } function outside(event:PointerEvent) { if (props.open && panel.value && !panel.value.contains(event.target as Node))emit('close'); }onMounted(() => document.addEventListener('pointerdown', outside)); onBeforeUnmount(() => document.removeEventListener('pointerdown', outside)); </script>
<style scoped>.filter-popover{position:absolute;z-index:8;top:calc(100% + 12px);right:0;width:min(370px,92vw);max-height:70vh;overflow:auto;padding:20px;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border-default);border-radius:18px;box-shadow:0 16px 44px #0002}.filter-popover section{padding:0 0 14px}.filter-popover h4{margin:0 0 8px;font-size:13px}.filter-popover label{display:flex;align-items:center;gap:10px;padding:7px 2px;cursor:pointer}.filter-popover input{accent-color:var(--accent)}.filter-popover small{margin-left:auto;color:var(--text-secondary)}.apply{width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:white;font-weight:600;cursor:pointer}.popover-enter-active,.popover-leave-active{transition:opacity .15s,transform .15s}.popover-enter-from,.popover-leave-to{opacity:0;transform:translateY(-5px)}@media(prefers-reduced-motion:reduce){.popover-enter-active,.popover-leave-active{transition:none}}</style>
