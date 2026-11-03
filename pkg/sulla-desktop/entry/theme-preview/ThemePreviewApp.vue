<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="preview-shell">
    <header class="preview-bar">
      <strong>Sulla renderer preview</strong>
      <label>Theme <select v-model="theme" @change="syncUrl"><option v-for="item in availableThemes" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
      <label>Page <select v-model="page" @change="syncUrl"><option v-for="item in pages" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
      <code>?theme={{ theme }}&amp;page={{ page }}</code>
    </header>
    <main class="preview-stage">
      <ChatFixture v-if="page === 'chat'" />
      <section v-else-if="page === 'appearance'" class="centered settings-fixture"><h1>Preferences</h1><AppearanceSection /></section>
      <section v-else-if="page === 'account'" class="full-page"><AccountEditor integration-id="openai" embedded /></section>
      <VaultPage v-else-if="page === 'vault'" />
      <MarketplaceTab v-else-if="page === 'use-cases'" />
      <HistoryTab v-else-if="page === 'history'" />
      <DecidePage v-else-if="page === 'decide'" />
      <FirstRunWelcome v-else-if="page === 'first-run'" :step-index="0" />
      <FilesPreviewHarness v-else-if="page === 'files'" />
      <Updates v-else-if="page === 'updates'" />
    </main>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { availableThemes, useTheme, type ThemeName } from '@pkg/composables/useTheme';
import AppearanceSection from '@pkg/components/settings/sections/AppearanceSection.vue';
import MarketplaceTab from '@pkg/components/routines/MarketplaceTab.vue';
import AccountEditor from '@pkg/pages/AccountEditor.vue';
import VaultPage from '@pkg/pages/VaultPage.vue';
import HistoryTab from '@pkg/pages/HistoryTab.vue';
import DecidePage from '@pkg/pages/DecidePage.vue';
import FirstRunWelcome from '@pkg/pages/FirstRunWelcome.vue';
import FilesPreviewHarness from '@pkg/pages/files/FilesPreviewHarness.vue';
import Updates from '@pkg/pages/Updates.vue';
import ChatFixture from './ChatFixture.vue';

const pages = [
  { id:'chat', label:'Chat' }, { id:'appearance', label:'Preferences / Appearance' },
  { id:'account', label:'Account / Profile' }, { id:'vault', label:'Vault' },
  { id:'use-cases', label:'Use Cases' }, { id:'history', label:'History' },
  { id:'decide', label:'Decide' }, { id:'first-run', label:'First Run Welcome' },
  { id:'files', label:'Files' }, { id:'updates', label:'Updates' },
] as const;
type PageId = typeof pages[number]['id'];
const params = new URLSearchParams(location.search);
const requestedTheme = params.get('theme');
const requestedPage = params.get('page');
const theme = ref<ThemeName>(availableThemes.some(item => item.id === requestedTheme) ? requestedTheme as ThemeName : 'studio-light');
const page = ref<PageId>(pages.some(item => item.id === requestedPage) ? requestedPage as PageId : 'chat');
const { setTheme } = useTheme();
function syncUrl() { history.replaceState(null, '', `?theme=${encodeURIComponent(theme.value)}&page=${encodeURIComponent(page.value)}`); }
watch(theme, value => { setTheme(value); syncUrl(); }, { immediate:true });
onMounted(syncUrl);
</script>
<style scoped>
.preview-shell{height:100vh;display:grid;grid-template-rows:48px minmax(0,1fr);background:var(--bg,var(--background,#fff));color:var(--text,var(--foreground,#171717))}.preview-bar{z-index:100;display:flex;align-items:center;gap:20px;padding:0 18px;border-bottom:1px solid var(--border,#d8d8d8);background:var(--surface-1,#f7f7f7);font:13px/1.2 system-ui}.preview-bar label{display:flex;align-items:center;gap:7px}.preview-bar select{color:inherit;background:var(--surface-2,#fff);border:1px solid var(--border,#ccc);border-radius:6px;padding:5px 26px 5px 8px}.preview-bar code{margin-left:auto;color:var(--text-muted,#666)}.preview-stage{min-height:0;overflow:auto}.centered{max-width:980px;margin:0 auto;padding:32px}.settings-fixture h1{font-size:28px;margin:0 0 24px}.full-page{min-height:100%;padding:24px}
</style>
