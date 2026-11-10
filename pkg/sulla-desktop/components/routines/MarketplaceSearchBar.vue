<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <form
    class="search-bar"
    @submit.prevent="$emit('submit')"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    ><circle
      cx="11"
      cy="11"
      r="7.5"
    /><path d="m16.5 16.5 4 4" /></svg><input
      :value="query"
      type="search"
      placeholder="Search use cases…"
      @input="$emit('update:query', ($event.target as HTMLInputElement).value)"
    ><button
      class="filter-trigger"
      type="button"
      :aria-expanded="filtersOpen"
      @click="$emit('toggle-filters')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      ><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle
        cx="15"
        cy="7"
        r="2"
      /><circle
        cx="9"
        cy="17"
        r="2"
      /></svg>Filters
    </button><button
      class="go"
      type="submit"
      aria-label="Search"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      ><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
    </button>
  </form>
</template>
<script setup lang="ts">defineProps<{ query: string; filtersOpen: boolean }>(); defineEmits<{ 'update:query': [value:string]; 'toggle-filters': []; submit: [] }>(); </script>
<style scoped>.search-bar{display:flex;align-items:center;gap:12px;min-height:68px;padding:8px 10px 8px 22px;border:0;border-radius:999px;background:var(--bg-surface-alt);box-shadow:0 8px 28px color-mix(in srgb,var(--text-primary) 8%,transparent);transition:background .15s ease,box-shadow .15s ease}.search-bar:focus-within{background:var(--bg-input);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 30%,transparent),0 8px 28px color-mix(in srgb,var(--text-primary) 8%,transparent)}.search-bar>svg{width:22px;height:22px;flex:none;color:var(--text-secondary)}input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text-primary);font-size:16px;box-shadow:none;-webkit-appearance:none;appearance:none}input::-webkit-search-decoration,input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}.filter-trigger,.go{display:flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer}.filter-trigger{padding:11px 15px;border-radius:999px;background:transparent;color:var(--text-primary)}.filter-trigger:hover{background:var(--bg-surface-hover)}.filter-trigger svg{width:20px;height:20px}.go{width:48px;height:48px;border-radius:50%;background:var(--accent);color:white}.go svg{width:21px;height:21px}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style>
