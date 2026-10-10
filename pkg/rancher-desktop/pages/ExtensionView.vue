<template>
  <div
    class="min-h-screen text-sm font-sans overflow-y-auto page-root"
    :class="{ dark: isDark }"
  >
    <div class="flex flex-col min-h-screen">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <!-- Iframe Mode -->
      <iframe
        v-if="extensionDisplayMode === 'iframe'"
        ref="iframeRef"
        :src="extensionContentUrl"
        scrolling="no"
        class="extension-frame w-full border-0"
        style="height: 100vh; overflow: hidden;"
        @load="onIframeLoad"
      />

      <!-- Embedded Mode -->
      <div
        v-else-if="extensionDisplayMode === 'embedded'"
        class="extension-embedded w-full flex-1"
        v-html="extensionContentHtml"
      />

      <!-- Loading State -->
      <div
        v-else
        class="extension-loading flex h-64 items-center justify-center"
      >
        <div class="text-center">
          <div class="extension-spinner mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
          <p class="text-sm text-slate-600 dark:text-slate-400">
            Loading {{ extensionMetadata?.title || 'extension' }} details...
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AgentHeader from './agent/AgentHeader.vue';

import { getExtensionService, LocalExtensionMetadata } from '@pkg/agent';
import { useTheme } from '@pkg/composables/useTheme';
import { hexEncode } from '@pkg/utils/string-encode';

const { isDark, toggleTheme } = useTheme();
const route = useRoute();
const router = useRouter();

const extensionService = getExtensionService();
const extensionMetadata = ref<LocalExtensionMetadata | null>(null);
const extensionIcon = ref<string>('');
const extensionDisplayMode = ref<'embedded' | 'iframe'>('iframe');
const extensionContentUrl = ref<string>('');
const extensionContentHtml = ref<string>('');

const onIframeLoad = () => {
  const iframe = document.querySelector('iframe')!;
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'theme', isDark: isDark.value }, '*');
  }
};

watch(isDark, (newVal) => {
  const iframe = document.querySelector('iframe')!;
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'theme', isDark: newVal }, '*');
  }
});

onMounted(async() => {
  const name = route.params.name as string;
  const path = (route.params.path as string[]).join('/');
  const metadata = extensionService.getExtensionMetadata(name) ?? null;

  if (!metadata) {
    router.push('/');
    return;
  }

  const extensionHex = hexEncode(metadata.id);
  const headerMenuItem = extensionService.getHeaderMenuItemByLink(`/Extension/${ metadata.name }/ui/${ path }`);

  extensionMetadata.value = metadata;
  extensionIcon.value = `x-rd-extension://${ extensionHex }/icon.svg`;
  extensionDisplayMode.value = headerMenuItem?.displayMode || 'iframe';
  extensionContentUrl.value = `x-rd-extension://${ extensionHex }/${ path }`;

  try {
    const response = await fetch(`x-rd-extension://${ extensionHex }/${ path }`);
    if (response.ok) {
      extensionContentHtml.value = await response.text();
    } else {
      console.error('Failed to load extension content:', response.status);
      extensionContentHtml.value = '<div class="p-4 text-red-600">Failed to load extension content.</div>';
    }
  } catch (error) {
    console.error('Error fetching extension content:', error);
    extensionContentHtml.value = '<div class="p-4 text-red-600">Error loading extension content.</div>';
  }
});
</script>

<style scoped>
.page-root {
  background: var(--bg-page);
  color: var(--text-primary);
}
</style>

<style scoped>
:global(.theme-noir) .page-root {
  background: radial-gradient(100% 55% at 0% 0%, color-mix(in srgb, var(--nx-accent) 9%, transparent), transparent 58%), var(--nx-paper);
  color: var(--nx-read-2);
}

:global(.theme-noir) .extension-frame,
:global(.theme-noir) .extension-embedded {
  background: color-mix(in srgb, var(--bg-surface-alt) 60%, transparent);
  border-top: 1px solid var(--nx-hair);
}

:global(.theme-noir) .extension-loading {
  margin: 30px;
  border: 1px solid var(--nx-hair);
  border-radius: 20px;
  color: var(--nx-read-3);
  background: color-mix(in srgb, var(--nx-hair-strong) 21.875%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 12.5%, transparent);
  animation: noir-extension-in 0.48s cubic-bezier(.22, 1, .36, 1) both;
}

:global(.theme-noir) .extension-loading p { color: var(--nx-read-3); }
:global(.theme-noir) .extension-spinner {
  border-color: color-mix(in srgb, var(--nx-hair-strong) 75%, transparent);
  border-top-color: var(--nx-accent-2);
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 22%, transparent);
}

@keyframes noir-extension-in {
  from { opacity: 0; transform: translateY(8px); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: none; }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .extension-loading { animation: none; }
}
</style>
