<template>
  <div
    class="h-screen overflow-hidden font-sans page-root flex flex-col"
    :class="{ dark: isDark }"
  >
    <AgentHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
    />

    <!-- Asset content -->
    <div
      v-if="asset"
      class="flex-1 min-h-0 overflow-hidden"
    >
      <!-- Iframe asset -->
      <webview
        v-if="asset.type === 'iframe' && asset.url"
        :src="asset.url"
        :title="asset.title"
        class="block h-full w-full"
      />

      <!-- Document asset -->
      <div
        v-else-if="asset.type === 'document'"
        class="h-full overflow-y-auto p-6"
      >
        <div
          class="prose prose-invert max-w-4xl mx-auto"
          v-html="sanitizedContent"
        />
      </div>
    </div>

    <!-- Asset not found -->
    <div
      v-else
      class="flex-1 flex items-center justify-center text-content-secondary"
    >
      <p>Asset not found.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import AgentHeader from './agent/AgentHeader.vue';
import { useTheme } from '@pkg/composables/useTheme';
import { getAgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';

const route = useRoute();
const { isDark, toggleTheme } = useTheme();

const registry = getAgentPersonaRegistry();
const persona = registry.getOrCreatePersonaService('sulla-desktop');

const assetId = computed(() => route.params.id as string);

const asset = computed(() => {
  return persona.activeAssets.find(a => a.id === assetId.value) ?? null;
});

const sanitizedContent = computed(() => {
  return asset.value?.content ?? '';
});
</script>

<style scoped>
.page-root {
  background: var(--bg-page);
  color: var(--text-primary);
}
</style>
