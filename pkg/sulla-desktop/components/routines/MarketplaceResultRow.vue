<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article
    class="result-row"
    tabindex="0"
    @click="$emit('open', row)"
    @keydown.enter.self="$emit('open', row)"
  >
    <div
      class="media"
      aria-hidden="true"
    >
      <img
        v-if="image && !imageFailed"
        :src="image"
        alt=""
        loading="lazy"
        @error="imageFailed = true"
      >
      <UseCaseIcon
        v-else
        :name="iconName"
      />
      <span
        v-if="isVideo"
        class="play"
      ><UseCaseIcon name="play" /></span>
    </div>
    <div class="body">
      <div class="byline">
        <b>{{ row.name }}</b><span>·</span><span>{{ row.category || 'Uncategorized' }}</span>
      </div>
      <h3>{{ row.tagline || row.name }}</h3>
      <p class="description">
        {{ row.description || '' }}
      </p>
      <div class="facts">
        <span>{{ row.kind_label || row.kind }}</span><span v-if="isVideo">Video walkthrough</span>
      </div>
    </div>
    <div
      class="actions"
      @click.stop
    >
      <button
        class="primary"
        type="button"
        :disabled="Boolean(installStatus)"
        @click="$emit('install', row)"
      >
        {{ installLabel }}
      </button>
      <button
        class="secondary"
        type="button"
        @click="$emit('detail', row)"
      >
        View details
      </button>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import UseCaseIcon from './UseCaseIcon.vue';

import type { MarketplaceBrowseRow } from '../../typings/electron-ipc';
const props = defineProps<{ row: MarketplaceBrowseRow; installStatus?: string }>();
defineEmits<{ open: [row: MarketplaceBrowseRow]; detail: [row: MarketplaceBrowseRow]; install: [row: MarketplaceBrowseRow] }>();
const image = computed(() => props.row.hero_media?.poster || (props.row.hero_media?.type !== 'video' ? props.row.hero_media?.url : ''));
const imageFailed = ref(false);
watch(image, () => { imageFailed.value = false });
const isVideo = computed(() => props.row.hero_media?.type === 'video');
const iconName = computed(() => ['agent', 'workflow', 'skill', 'function', 'integration', 'recipe'].includes(props.row.kind) ? props.row.kind : 'box');
const installLabel = computed(() => props.installStatus === 'installed' ? 'Added to Sulla' : props.installStatus === 'installing' ? 'Adding…' : 'Add to Sulla');
</script>
<style scoped>
.result-row{display:grid;grid-template-columns:minmax(190px,304px) minmax(0,1fr) 184px;gap:24px;padding:22px 0;border-bottom:1px solid var(--border-muted);cursor:pointer}.media{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:var(--surface-2);display:grid;place-items:center;color:var(--text-dim)}.media img{width:100%;height:100%;object-fit:cover}.media :deep(svg){width:34px;height:34px}.play{position:absolute;inset:0;display:grid;place-items:center}.play :deep(svg){width:42px;height:42px;padding:10px;border-radius:50%;background:#ffffffed;color:#222;box-shadow:0 2px 8px #0002}.body{min-width:0}.byline{display:flex;gap:7px;align-items:center;font-size:13px;color:var(--text-muted);margin:2px 0 6px}.byline b{font-size:14px;font-weight:600;color:var(--text)}h3{margin:0 0 6px;font-size:17px;font-weight:600;line-height:1.3}.description{color:var(--text-muted);margin:0 0 12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.facts{display:flex;gap:16px;flex-wrap:wrap;color:var(--text-muted);font-size:13px}.actions{border-left:1px solid var(--border-muted);padding-left:22px;display:flex;flex-direction:column;justify-content:center;gap:8px}.actions button{height:38px;border-radius:20px;padding:0 12px;cursor:pointer;font-weight:600}.primary{border:0;background:var(--accent);color:white}.primary:disabled{opacity:.68;cursor:default}.secondary{border:1px solid var(--border);background:var(--surface-1);color:var(--text)}
@media(max-width:900px){.result-row{grid-template-columns:minmax(145px,34%) minmax(0,1fr);gap:14px}.actions{grid-column:2;border:0;padding:0;flex-direction:row;justify-content:flex-start}.actions button{flex:1;max-width:180px}}
</style>
