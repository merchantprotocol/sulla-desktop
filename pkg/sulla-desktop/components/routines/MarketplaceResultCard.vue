<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article
    class="card"
    tabindex="0"
    @click="$emit('open', row)"
    @keydown.enter.self="$emit('open', row)"
  >
    <div class="media">
      <img
        v-if="image && !imageFailed"
        :src="image"
        alt=""
        loading="lazy"
        @error="imageFailed = true"
      ><UseCaseIcon
        v-else
        :name="iconName"
      /><span
        v-if="row.hero_media?.type === 'video'"
        class="play"
      ><UseCaseIcon name="play" /></span>
    </div>
    <div class="copy">
      <span class="avatar"><UseCaseIcon :name="iconName" /></span><div class="text">
        <h3>{{ row.tagline || row.name }}</h3><p>{{ row.name }} · {{ row.category || 'Uncategorized' }}</p><small>{{ row.kind_label || row.kind }}<template v-if="row.hero_media?.type === 'video'"> · Video walkthrough</template></small>
      </div>
    </div>
    <div
      class="buttons"
      @click.stop
    >
      <button
        class="primary"
        type="button"
        :disabled="Boolean(installStatus)"
        @click="$emit('install', row)"
      >
        {{ installStatus === 'installed' ? 'Added to Sulla' : installStatus === 'installing' ? 'Adding…' : 'Add to Sulla' }}
      </button><button
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
const iconName = computed(() => ['agent', 'workflow', 'skill', 'function', 'integration', 'recipe'].includes(props.row.kind) ? props.row.kind : 'box');
</script>
<style scoped>
.card{min-width:0;cursor:pointer}.media{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:var(--surface-2);display:grid;place-items:center;color:var(--text-dim)}.media img{width:100%;height:100%;object-fit:cover}.media> :deep(svg){width:34px;height:34px}.play{position:absolute;inset:0;display:grid;place-items:center}.play :deep(svg){width:42px;height:42px;padding:10px;border-radius:50%;background:#ffffffed;color:#222}.copy{display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px;padding:12px 0}.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);color:var(--accent)}.avatar :deep(svg){width:20px;height:20px}.text h3{font-size:15px;line-height:1.35;margin:0 0 4px;font-weight:600}.text p,.text small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;color:var(--text-muted);font-size:12px}.text small{margin-top:4px;color:var(--text-dim)}.buttons{display:flex;gap:8px}.buttons button{height:34px;border-radius:18px;padding:0 12px;cursor:pointer;font-size:12px}.primary{border:0;background:var(--accent);color:white;font-weight:600}.primary:disabled{opacity:.65}.buttons button:last-child{border:1px solid var(--border);background:var(--surface-1);color:var(--text)}
</style>
