<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Grid of source cards for Sulla's grounding. -->
<template>
  <div class="citation-grid">
    <a
      v-for="s in msg.sources"
      :key="s.num"
      class="citation-card"
      :href="s.url || '#'"
      :target="s.url ? '_blank' : undefined"
      :rel="s.url ? 'noopener' : undefined"
    >
      <div class="citation-title">{{ s.title }}</div>
      <div class="citation-meta"><span class="citation-number">{{ s.num }}</span><span class="citation-origin">{{ s.origin }}</span></div>
    </a>
  </div>
</template>

<script setup lang="ts">
import type { CitationMessage } from '../../models/Message';
defineProps<{ msg: CitationMessage }>();
</script>

<style scoped>
.citation-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px; margin: 4px 0;
}
.citation-card {
  padding: 10px 12px; border-radius: 8px;
  background: var(--accent-glow);
  border: 1px solid var(--accent-dim);
  display: flex; flex-direction: column; gap: 6px;
  min-width: 0; cursor: pointer;
  text-decoration: none; color: inherit;
  transition: all 0.2s ease;
}
.citation-card:hover {
  border-color: var(--accent-glow);
  background: var(--accent-dim);
  color: var(--text-primary);
  box-shadow: 0 0 14px var(--accent-dim);
}
.citation-card .citation-title {
  font-family: var(--font-display); font-size: 13px;
  color: var(--text-primary); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  line-height: 1.4;
}
.citation-card .citation-meta {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);
}
.citation-card .citation-number {
  padding: 0 5px; border-radius: 3px;
  background: var(--accent-dim); color: var(--accent-hover);
  font-weight: 700;
}
</style>
