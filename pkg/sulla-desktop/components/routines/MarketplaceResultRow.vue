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
      <span
        v-if="presentation.duration"
        class="duration"
      >{{ presentation.duration }}</span>
      <span
        v-if="!image || imageFailed"
        class="media-title"
      >{{ row.name }} · {{ presentation.topic }}</span>
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
        <button type="button" @click.stop="emit('filter', 'type', row.kind)">{{ row.kind_label || row.kind }}</button><button v-if="row.topic || row.category" type="button" @click.stop="emit('filter', 'topic', row.topic || row.category)">{{ row.topic || row.category }}</button><span v-if="isVideo">Video walkthrough</span><span
          v-for="app in presentation.apps"
          :key="app"
        >Works with {{ app }}</span><span v-if="presentation.draftsOnly">Drafts only</span>
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
      <span
        v-if="presentation.price"
        class="price"
      >{{ presentation.price }}</span>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import UseCaseIcon from './UseCaseIcon.vue';

import { MarketplaceListingPresenter } from '@pkg/composables/MarketplaceListingPresenter';

import type { MarketplaceBrowseRow } from '../../typings/electron-ipc';
const props = defineProps<{ row: MarketplaceBrowseRow; installStatus?: string }>();
const presentation = computed(() => new MarketplaceListingPresenter().present(props.row));
const emit = defineEmits<{ open: [row: MarketplaceBrowseRow]; detail: [row: MarketplaceBrowseRow]; install: [row: MarketplaceBrowseRow]; filter: [key: 'topic' | 'type', value: string] }>();
const image = computed(() => presentation.value.image);
const imageFailed = ref(false);
watch(image, () => { imageFailed.value = false });
const isVideo = computed(() => presentation.value.video);
const iconName = computed(() => ['agent', 'workflow', 'skill', 'function', 'integration', 'recipe'].includes(props.row.kind) ? props.row.kind : 'box');
const installLabel = computed(() => props.installStatus === 'installed' ? 'Added to Sulla' : props.installStatus === 'installing' ? 'Adding…' : 'Add to Sulla');
</script>
<style scoped>
.result-row{display:grid;grid-template-columns:minmax(190px,304px) minmax(0,1fr) 184px;gap:24px;padding:22px 0;border-bottom:1px solid var(--border-muted,#eee);cursor:pointer}.media{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:var(--surface-2,#f4f5f5);display:grid;place-items:center;color:var(--text-dim,#888)}.media img{width:100%;height:100%;object-fit:cover}.media :deep(svg){width:34px;height:34px}.play{position:absolute;inset:0;display:grid;place-items:center}.play :deep(svg){width:42px;height:42px;padding:10px;border-radius:50%;background:#ffffffed;color:#222;box-shadow:0 2px 8px #0002}.body{min-width:0}.byline{display:flex;gap:7px;align-items:center;font-size:13px;color:var(--text-muted,#777);margin:2px 0 6px}.byline b{font-size:14px;font-weight:600;color:var(--text,#222)}h3{margin:0 0 6px;font-size:17px;font-weight:600;line-height:1.3}.description{color:var(--text-muted,#555);margin:0 0 12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.facts{display:flex;gap:16px;flex-wrap:wrap;color:var(--text-muted,#666);font-size:13px}.actions{border-left:1px solid var(--border-muted,#eee);padding-left:22px;display:flex;flex-direction:column;justify-content:center;gap:8px}.actions button{height:38px;border-radius:20px;padding:0 12px;cursor:pointer;font-weight:600}.primary{border:0;background:var(--accent,#397f99);color:white}.primary:disabled{opacity:.68;cursor:default}.secondary{border:1px solid var(--border,#ddd);background:var(--surface-1,#fff);color:var(--text,#222)}
.duration{position:absolute;right:8px;bottom:8px;padding:3px 6px;border-radius:5px;background:#17191bcc;color:#fff;font-size:11px}.media-title{padding:12px;text-align:center;color:var(--text-muted,#666)}.price{font-weight:600;text-align:center;color:var(--text,#222)}
@media(max-width:900px){.result-row{grid-template-columns:minmax(145px,34%) minmax(0,1fr);gap:14px}.actions{grid-column:2;border:0;padding:0;flex-direction:row;justify-content:flex-start}.actions button{flex:1;max-width:180px}}
</style>
