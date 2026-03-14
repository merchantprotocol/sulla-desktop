<template>
  <header class="sticky top-0 z-50 flex flex-none flex-wrap items-center justify-between bg-white px-4 py-5 shadow-md shadow-slate-900/5 transition duration-500 sm:px-6 lg:px-8 dark:shadow-none dark:bg-slate-900/95 dark:backdrop-blur-sm dark:[@supports(backdrop-filter:blur(0))]:bg-slate-900/75">
    <div class="relative flex grow basis-0 items-center">
      <a aria-label="Home page" :href="homeUrl || '#/'">
        <img
          :src="logoLightUrl"
          alt="Sulla Desktop"
          class="h-9 w-auto dark:hidden"
        >
        <img
          :src="logoDarkUrl"
          alt="Sulla Desktop"
          class="hidden h-9 w-auto dark:block"
        >
      </a>
    </div>
    <div class="relative flex basis-0 justify-end gap-6 sm:gap-8">
      <div class="relative z-10" data-headlessui-state="">
        <label class="sr-only" for="headlessui-listbox-button-_r_a_" id="headlessui-label-_r_9_" data-headlessui-state="">Theme</label>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 0 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z" />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 1 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1 1 1 0 0 1 1-1Z" />
          </svg>
        </button>
      </div>
      <button
        class="cursor-pointer active:bg-gray-200 dark:active:bg-gray-600 flex h-6 px-2 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset text-black dark:text-gray-300 text-sm"
        type="button"
        aria-label="Stop Sulla"
        @click="onStop"
        v-if="onStop"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 mr-1">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
        Quit
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  isDark: boolean;
  toggleTheme: () => void;
  onStop?: () => void;
  homeUrl?: string;
}>();

const logoLightUrl = new URL('../../../../resources/icons/logo-sulla-desktop-nobg.png', import.meta.url).toString();
const logoDarkUrl = new URL('../../../../resources/icons/logo-sulla-desktop-dark-nobg.png', import.meta.url).toString();
</script>
