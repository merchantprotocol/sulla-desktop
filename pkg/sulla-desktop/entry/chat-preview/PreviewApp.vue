<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <main class="preview">
    <nav aria-label="Chat preview controls">
      <label>Theme
        <select v-model="theme">
          <option v-for="option in availableThemes" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>
      <label>Fixture
        <select :value="fixture" @change="pickFixture">
          <option value="long">Long conversation</option>
          <option value="agent">Agent origin + long title</option>
        </select>
      </label>
      <label>Dock
        <select :value="dock.position.value" @change="pickDock">
          <option value="bottom">Closed</option>
          <option value="side">Right side</option>
        </select>
      </label>
      <span>Synthetic data · no backend</span>
    </nav>
    <section class="preview-chat">
      <ChatPage :key="fixture" :tab-id="ConversationFixture.tabId" :is-active="true" />
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue';

import { availableThemes, ThemeStore } from '@pkg/composables/useTheme';
import ChatPage from '@pkg/pages/chat/ChatPage.vue';
import { DockPositions } from '@pkg/pages/chat/composables/useDockPosition';
import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';
import { ConversationFixture, type FixtureName } from './ConversationFixture';

const query = new URLSearchParams(location.search);
const selectedTheme = query.get('theme') ?? '';
const theme = ref(ThemeStore.isValidTheme(selectedTheme) ? selectedTheme : 'default-light');
const fixture = ref<FixtureName>(query.get('fixture') === 'agent' ? 'agent' : 'long');
const level = query.get('level') === 'debug' ? 'debug' : 'info';
const seed = new ConversationFixture(new LocalStoragePersister());
const dock = DockPositions.use();

seed.seed(fixture.value);
dock.setPosition(query.get('dock') === 'side' ? 'side' : 'bottom');

function pickFixture(event: Event): void {
  const next = (event.target as HTMLSelectElement).value === 'agent' ? 'agent' : 'long';
  seed.seed(next);
  fixture.value = next;
}

function pickDock(event: Event): void {
  dock.setPosition((event.target as HTMLSelectElement).value === 'side' ? 'side' : 'bottom');
}

provide('chat:agent-origin', computed(() => fixture.value === 'agent'
  ? { name: 'Fixture Planner', back: () => {
    seed.seed('long');
    fixture.value = 'long';
  } }
  : null));

onMounted(async() => {
  // Drive the real ChatPage v-model instead of introducing a preview-only reporting prop.
  await nextTick();
  const reporting = document.querySelector<HTMLSelectElement>('.ch-reporting');
  if (reporting && reporting.value !== level) {
    reporting.value = level;
    reporting.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

watch([theme, fixture, dock.position], ([name, sample, position]) => {
  ThemeStore.shared().applyThemeClass(name);
  history.replaceState(null, '', `?${new URLSearchParams({ theme: name, fixture: sample, dock: position, level })}`);
}, { immediate: true });
</script>

<style>
html, body, #app { margin: 0; height: 100%; }
.preview { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); color: var(--text-primary); background: var(--bg-surface); }
.preview > nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 12px; border-bottom: 1px solid var(--border-default); font: 12px var(--font-body, system-ui, sans-serif); }
.preview > nav select { color: inherit; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 4px; }
.preview-chat { position: relative; min-width: 0; min-height: 0; }
</style>
