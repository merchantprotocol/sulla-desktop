<template>
  <div class="min-h-screen text-sm font-sans overflow-y-auto page-root" :class="{ dark: isDark }">
    <PostHogTracker page-name="Extension" />
    <div class="flex flex-col min-h-screen">
      <AgentHeader :is-dark="isDark" :toggle-theme="toggleTheme" />

      <!-- Iframe Mode -->
      <iframe v-if="extensionDisplayMode === 'iframe'" 
        ref="iframeRef"
        :src="extensionContentUrl" 
        @load="onIframeLoad"
        scrolling="no"
        class="w-full border-0"
        style="height: 100vh; overflow: hidden;">
      </iframe>

      <!-- Embedded Mode -->
      <div v-else-if="extensionDisplayMode === 'embedded'" 
        v-html="extensionContentHtml" 
        class="w-full flex-1">
      </div>

      <!-- Loading State -->
      <div v-else class="flex h-64 items-center justify-center">
        <div class="text-center">
          <div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"></div>
          <p class="text-sm text-slate-600 dark:text-slate-400">Loading {{ extensionMetadata?.title || 'extension' }} details...</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AgentHeader from './agent/AgentHeader.vue';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getExtensionService, LocalExtensionMetadata } from '@pkg/agent';
import { hexEncode } from '@pkg/utils/string-encode';

const THEME_STORAGE_KEY = 'agentTheme';
const isDark = ref(false);
const route = useRoute();
const router = useRouter();

const extensionService = getExtensionService();
const extensionMetadata = ref<LocalExtensionMetadata | null>(null);
const extensionIcon = ref<string>('');
const extensionDisplayMode = ref<'embedded' | 'iframe'>('iframe');
const extensionContentUrl = ref<string>('');
const extensionContentHtml = ref<string>('');

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
};

const onIframeLoad = () => {
  const iframe = document.querySelector('iframe') as HTMLIFrameElement;
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'theme', isDark: isDark.value }, '*');
  }
};

watch(isDark, (newVal) => {
  const iframe = document.querySelector('iframe') as HTMLIFrameElement;
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'theme', isDark: newVal }, '*');
  }
});

onMounted(async () => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    isDark.value = saved === 'dark';
  } catch {
    isDark.value = false;
  }

  const name = route.params.name as string;
  const path = (route.params.path as string[]).join('/');
  const metadata = extensionService.getExtensionMetadata(name) ?? null;

  if (!metadata) {
    router.push('/');
    return;
  }

  const extensionHex = hexEncode(metadata.id);
  const headerMenuItem = extensionService.getHeaderMenuItemByLink(`/Extension/${metadata.name}/ui/${path}`);

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
  background: #ffffff;
  color: #0d0d0d;
}

.page-root.dark {
  background: #0f172a;
  color: #fafafa;
}
</style>
