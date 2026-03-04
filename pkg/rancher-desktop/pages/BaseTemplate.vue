<!--
BaseTemplate.vue is used as a layout component loaded by entry/index.ts.
entry/index.ts dynamically determines the layout based on the current route's component.layout property.

-->
<template>
  <div class="h-screen overflow-hidden bg-white text-[#0d0d0d] dark:bg-slate-900 dark:text-neutral-50 font-sans" :class="{ dark: isDark }">
    <div class="flex h-screen flex-col">

      <SimpleHeader :is-dark="isDark" :toggle-theme="toggleTheme"/>

      <!-- Main agent interface -->
      <div ref="chatScrollContainer" id="chat-scroll-container" class="flex min-h-0 flex-1 overflow-y-auto">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <div class="relative mx-auto flex w-full max-w-8xl flex-1 justify-center sm:px-2 lg:px-8 xl:px-12">
            <div class="hidden lg:relative lg:block lg:flex-none lg:w-72 xl:w-80 bg-slate-50 dark:bg-slate-800/30">
              <div class="sticky top-[15px] pt-[15px] h-[calc(100vh-5rem-15px)] w-full overflow-x-hidden overflow-y-auto">

                <!-- sidebar slot -->

              </div>
            </div>

            <div class="max-w-2xl min-w-0 flex-auto px-4 py-16 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
              <div ref="transcriptEl" id="chat-messages-list" class="pb-40">

                <!-- main slot -->

              </div>
            </div>

            <div class="hidden xl:sticky xl:top-0 xl:-mr-6 xl:block xl:max-h-[calc(100vh-12rem)] xl:flex-none xl:overflow-y-auto xl:pr-6">
              <div class="w-72">

              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import SimpleHeader from './agent/SimpleHeader.vue';
import './assets/theme.css';

const isDark = ref(false);
const THEME_STORAGE_KEY = 'agentTheme';

onMounted(async () => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);

  if (stored === 'dark') {
    isDark.value = true;
  } else if (stored === 'light') {
    isDark.value = false;
  } else {
    isDark.value = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }
});

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
};
</script>

<style lang="scss">
html {
  height: initial;
}
</style>