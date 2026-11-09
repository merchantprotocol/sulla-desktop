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
              v-else-if="presentation.image"
              :src="presentation.image"
              :alt="row.name"
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
let returnFocus: HTMLElement | null = null;
watch(() => props.row, async row => {
  if (row) { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); closeButton.value?.focus() } else { await nextTick(); returnFocus?.focus(); returnFocus = null }
}, { immediate: true });
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !sheet.value) return;
  const items = [...sheet.value.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), video[controls]')];
  if (!items.length) return;
  const first = items[0]; const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.value)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onBeforeUnmount(() => returnFocus?.focus());
</script>
<style scoped>
.text-tile{padding:24px;text-align:center}
</style>
