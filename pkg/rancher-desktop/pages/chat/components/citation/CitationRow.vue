<!-- Grid of source cards for Sulla's grounding. -->
<template>
  <div class="citations">
    <a
      v-for="s in msg.sources"
      :key="s.num"
      class="cite-card"
      :href="s.url || '#'"
      :target="s.url ? '_blank' : undefined"
      :rel="s.url ? 'noopener' : undefined"
    >
      <div class="title">{{ s.title }}</div>
      <div class="meta"><span class="num">{{ s.num }}</span>{{ s.origin }}</div>
    </a>
  </div>
</template>

<script setup lang="ts">
import type { CitationMessage } from '../../models/Message';
defineProps<{ msg: CitationMessage }>();
</script>

<style scoped>
.citations {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px; margin: 4px 0;
}
.cite-card {
  padding: 10px 12px; border-radius: 8px;
  background: rgba(20, 30, 42, 0.4);
  border: 1px solid rgba(168, 192, 220, 0.15);
  display: flex; flex-direction: column; gap: 6px;
  min-width: 0; cursor: pointer;
  text-decoration: none; color: inherit;
  transition: all 0.2s ease;
}
.cite-card:hover {
  border-color: rgba(80, 150, 179, 0.4);
  background: rgba(20, 30, 42, 0.7);
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.18);
}
.cite-card .title {
  font-family: var(--serif); font-size: 13px;
  color: var(--read-1); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  line-height: 1.4;
}
.cite-card .meta {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 10px; color: var(--read-4);
}
.cite-card .num {
  padding: 0 5px; border-radius: 3px;
  background: rgba(80, 150, 179, 0.14); color: var(--steel-400);
  font-weight: 700;
}
</style>
