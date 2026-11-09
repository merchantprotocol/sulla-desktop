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
              v-if="row.hero_media?.type === 'video'"
              :src="row.hero_media.url"
              :poster="row.hero_media.poster"
              controls
              playsinline
            />
            <img
              v-else-if="row.hero_media?.url && !imageFailed"
              :src="row.hero_media.poster || row.hero_media.url"
              :alt="row.name"
              @error="imageFailed = true"
            >
            <UseCaseIcon
              v-else
              :name="iconName"
            />
          </div>
          <p class="tagline">
            {{ row.tagline || row.name }}
          </p>
          <h2>{{ row.name }}</h2>
          <h3>What you get</h3><p class="description">
            {{ row.description || 'Explore the full details to learn more about this use case.' }}
          </p>
          <div class="facts">
            <span>{{ row.kind_label || row.kind }}</span><span>{{ row.category || 'Uncategorized' }}</span><span v-if="row.hero_media?.type === 'video'">Video walkthrough</span>
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

import UseCaseIcon from './UseCaseIcon.vue';

import type { MarketplaceBrowseRow } from '../../typings/electron-ipc';
const props = defineProps<{ row: MarketplaceBrowseRow | null; installStatus?: string }>();
defineEmits<{ close: []; detail: [row: MarketplaceBrowseRow]; install: [row: MarketplaceBrowseRow] }>();
const sheet = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const imageFailed = ref(false);
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = ''; let previousHtmlOverflow = ''; let scrollLocked = false;
const iconName = computed(() => ['agent', 'workflow', 'skill', 'function', 'integration', 'recipe'].includes(props.row?.kind ?? '') ? props.row!.kind : 'box');
watch(() => props.row, async row => {
  if (row) {
    imageFailed.value = false;
    if (!scrollLocked) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousBodyOverflow = document.body.style.overflow; previousHtmlOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; scrollLocked = true;
      await nextTick(); closeButton.value?.focus();
    }
  } else if (scrollLocked) {
    document.body.style.overflow = previousBodyOverflow; document.documentElement.style.overflow = previousHtmlOverflow; scrollLocked = false;
    await nextTick(); returnFocus?.focus(); returnFocus = null;
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
.quick-view{position:fixed;inset:0;z-index:1000}.scrim{position:absolute;inset:0;border:0;background:rgb(20 24 26 / 22%);opacity:1;animation:fade .2s ease both}.sheet{position:absolute;top:12px;right:12px;bottom:12px;width:min(560px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;border-radius:28px;background:var(--surface-1);color:var(--text);box-shadow:0 20px 60px #0002;animation:slide .3s ease both}.sheet header{display:flex;justify-content:space-between;align-items:center;padding:15px 20px;color:var(--text-muted);font-size:13px}.sheet header button{width:34px;height:34px;border:0;border-radius:50%;background:var(--surface-2);font-size:23px;cursor:pointer}.content{padding:4px 24px 22px;overflow:auto;flex:1}.player{aspect-ratio:16/9;overflow:hidden;border-radius:18px;background:var(--surface-2);display:grid;place-items:center;color:var(--text-dim)}.player img,.player video{width:100%;height:100%;object-fit:cover}.player :deep(svg){width:38px;height:38px}.tagline{margin:22px 0 5px;color:var(--text-muted)}h2{font-size:25px;margin:0 0 23px}h3{font-size:14px;margin:0 0 8px}.description{line-height:1.6;color:var(--text-muted);white-space:pre-wrap}.facts{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.facts span{padding:6px 10px;border-radius:20px;background:var(--surface-2);font-size:12px;color:var(--text-muted)}footer{display:flex;gap:10px;padding:16px 24px;border-top:1px solid var(--border-muted)}footer button{height:42px;padding:0 18px;border-radius:24px;font-weight:600;cursor:pointer}.primary{border:0;background:var(--accent);color:#fff}.primary:disabled{opacity:.65}footer button:last-child{border:1px solid var(--border);background:var(--surface-1);color:var(--text)}@keyframes fade{from{opacity:0}to{opacity:1}}@keyframes slide{from{transform:translateX(100%)}to{transform:none}}@media(prefers-reduced-motion:reduce){.sheet,.scrim{animation:none}}
</style>
