<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Teleport to="body">
    <div
      v-if="row"
      class="quick-view"
      @keydown.esc.stop.prevent="$emit('close')"
    >
      <button
        class="scrim"
        aria-label="Close quick view"
        @click="$emit('close')"
      />
      <section
        ref="sheet"
        class="sheet"
        role="dialog"
        aria-modal="true"
        :aria-label="row.name"
        tabindex="-1"
        @keydown="trapFocus"
      >
        <header>
          <span>Quick view</span><button
            ref="closeButton"
            type="button"
            aria-label="Close"
            @click="$emit('close')"
          >
            ×
          </button>
        </header>
        <div class="content">
          <div class="player">
            <video
              v-if="presentation.video && (row.video_url || row.hero_media?.url)"
              :src="row.video_url || row.hero_media?.url"
              :poster="presentation.image"
              controls
              playsinline
            />
            <img
              v-else-if="presentation.image && !imageFailed"
              :src="presentation.image"
              :alt="row.name"
              @error="imageFailed = true"
            >
            <div
              v-else
              class="text-tile"
            >
              <b>{{ row.name }}</b><span>{{ presentation.topic }}</span>
            </div>
          </div>
          <p class="tagline">
            {{ row.tagline || row.name }}
          </p>
          <h2>{{ row.name }}</h2>
          <h3>What you get</h3><p class="description">
            {{ row.description || 'Explore the full details to learn more about this use case.' }}
          </p>
          <div class="facts">
            <span>{{ row.kind_label || row.kind }}</span><span>{{ presentation.topic }}</span><span v-if="presentation.video">Video walkthrough <template v-if="presentation.duration">· {{ presentation.duration }}</template></span><span
              v-for="app in presentation.apps"
              :key="app"
            >Works with {{ app }}</span><span v-if="presentation.draftsOnly">Drafts only</span><span v-if="presentation.price">{{ presentation.price }}</span>
          </div>
        </div>
        <footer>
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
            Full details
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch, ref } from 'vue';

import { MarketplaceListingPresenter } from '@pkg/composables/MarketplaceListingPresenter';

import type { MarketplaceBrowseRow } from '../../typings/electron-ipc';
const props = defineProps<{ row: MarketplaceBrowseRow | null; installStatus?: string }>();
const presentation = computed(() => props.row ? new MarketplaceListingPresenter().present(props.row) : { image: '', video: false, duration: '', price: '', topic: '', apps: [], draftsOnly: false });
defineEmits<{ close: []; detail: [row: MarketplaceBrowseRow]; install: [row: MarketplaceBrowseRow] }>();
const sheet = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const imageFailed = ref(false);
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = '';
let previousHtmlOverflow = '';
let scrollLocked = false;
watch(() => props.row, async row => {
  if (row) {
    imageFailed.value = false;
    if (!scrollLocked) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousBodyOverflow = document.body.style.overflow;
      previousHtmlOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      scrollLocked = true;
      await nextTick();
      closeButton.value?.focus();
    }
  } else if (scrollLocked) {
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
    scrollLocked = false;
    await nextTick();
    returnFocus?.focus();
    returnFocus = null;
  }
}, { immediate: true });
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !sheet.value) return;
  const items = [...sheet.value.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), video[controls]')];
  if (!items.length) return;
  const first = items[0]; const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.value)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onBeforeUnmount(() => {
  if (scrollLocked) {
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
  }
  returnFocus?.focus();
});
</script>
<style scoped>
.quick-view{position:fixed;inset:0;z-index:1000}.scrim{position:absolute;inset:0;border:0;background:rgb(20 24 26 / 22%);opacity:1;animation:fade .2s ease both}.sheet{position:absolute;top:12px;right:12px;bottom:12px;width:min(560px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;border-radius:28px;background:var(--surface-1,#fff);color:var(--text,#222);box-shadow:0 20px 60px #0002;animation:slide .3s ease both}.sheet header{display:flex;justify-content:space-between;align-items:center;padding:15px 20px;color:var(--text-muted,#777);font-size:13px}.sheet header button{width:34px;height:34px;border:0;border-radius:50%;background:var(--surface-2,#f5f5f5);font-size:23px;cursor:pointer}.content{padding:4px 24px 22px;overflow:auto;flex:1}.player{aspect-ratio:16/9;overflow:hidden;border-radius:18px;background:var(--surface-2,#f3f4f4);display:grid;place-items:center;color:var(--text-dim,#888)}.player img,.player video{width:100%;height:100%;object-fit:cover}.player :deep(svg){width:38px;height:38px}.tagline{margin:22px 0 5px;color:var(--text-muted,#666)}h2{font-size:25px;margin:0 0 23px}h3{font-size:14px;margin:0 0 8px}.description{line-height:1.6;color:var(--text-muted,#555);white-space:pre-wrap}.facts{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.facts span{padding:6px 10px;border-radius:20px;background:var(--surface-2,#f4f5f5);font-size:12px;color:var(--text-muted,#555)}footer{display:flex;gap:10px;padding:16px 24px;border-top:1px solid var(--border-muted,#eee)}footer button{height:42px;padding:0 18px;border-radius:24px;font-weight:600;cursor:pointer}.primary{border:0;background:var(--accent,#397f99);color:#fff}.primary:disabled{opacity:.65}footer button:last-child{border:1px solid var(--border,#ddd);background:var(--surface-1,#fff);color:var(--text,#222)}@keyframes fade{from{opacity:0}to{opacity:1}}@keyframes slide{from{transform:translateX(100%)}to{transform:none}}@media(prefers-reduced-motion:reduce){.sheet,.scrim{animation:none}}
.text-tile{padding:24px;text-align:center}
</style>
