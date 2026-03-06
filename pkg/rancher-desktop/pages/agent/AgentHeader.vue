<template>
  <header class="sticky top-0 z-50 flex flex-none flex-wrap items-center justify-between bg-white px-4 py-5 shadow-md shadow-slate-900/5 transition duration-500 sm:px-6 lg:px-8 dark:shadow-none dark:bg-slate-900/95 dark:backdrop-blur-sm dark:[@supports(backdrop-filter:blur(0))]:bg-slate-900/75">
    <div class="mr-6 flex lg:hidden">
      <button type="button" class="relative" aria-label="Open navigation" @click="toggleMobileMenu">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" class="h-6 w-6 stroke-slate-500">
          <path d="M4 7h16M4 12h16M4 17h16"></path>
        </svg>
      </button>
    </div>
    <div class="relative flex grow basis-0 items-center">
      <a aria-label="Home page" href="#/">
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
    <div class="-my-5 mr-6 sm:mr-8 md:mr-0 hidden lg:block">
      <nav class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-x-6">
        <router-link
          to="/Chat"
          class="text-sm font-semibold"
          :class="route.path === '/Chat' ? 'text-[#0d0d0d] dark:text-white' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] dark:text-white/60 dark:hover:text-white'"
        >
          Chat
        </router-link>
        <router-link
          to="/Calendar"
          class="text-sm font-semibold"
          :class="route.path === '/Calendar' ? 'text-[#0d0d0d] dark:text-white' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] dark:text-white/60 dark:hover:text-white'"
        >
          Calendar
        </router-link>
        <router-link
          to="/Integrations"
          class="text-sm font-semibold"
          :class="route.path === '/Integrations' ? 'text-[#0d0d0d] dark:text-white' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] dark:text-white/60 dark:hover:text-white'"
        >
          Integrations
        </router-link>
        <router-link
          to="/Extensions"
          class="text-sm font-semibold"
          :class="route.path === '/Extensions' ? 'text-[#0d0d0d] dark:text-white' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] dark:text-white/60 dark:hover:text-white'"
        >
          Extensions
        </router-link>
        <router-link
          v-for="item in extensionMenuItems"
          :key="item.link"
          :to="item.link"
          class="text-sm font-semibold"
          :class="route.path === item.link ? 'text-[#0d0d0d] dark:text-white' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] dark:text-white/60 dark:hover:text-white'"
        >
          {{ item.title }}
        </router-link>
      </nav>
    </div>
    <div class="relative flex basis-0 justify-end gap-6 sm:gap-8">
      <div v-if="route.path === '/Filesystem'" class="flex gap-2">
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset"
          type="button"
          aria-label="Toggle left pane"
          @click="$emit('toggle-left-pane')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="9" y1="9" x2="15" y2="9"/>
            <line x1="9" y1="12" x2="15" y2="12"/>
            <line x1="9" y1="15" x2="13" y2="15"/>
          </svg>
        </button>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset"
          type="button"
          aria-label="Toggle center pane"
          @click="$emit('toggle-center-pane')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </button>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset"
          type="button"
          aria-label="Toggle right pane"
          @click="$emit('toggle-right-pane')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="9" cy="9" r="2"/>
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
          </svg>
        </button>
      </div>
      <div class="relative z-10" data-headlessui-state="">
        <label class="sr-only" for="headlessui-listbox-button-_r_a_" id="headlessui-label-_r_9_" data-headlessui-state="">Theme</label>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5 dark:bg-slate-700 dark:ring-white/5 dark:ring-inset"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 1 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z" />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 0 1 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1 1 1 0 0 1 1-1Z" />
          </svg>
        </button>
      </div>
      <a class="group" aria-label="GitHub" href="https://github.com/sulla-ai/sulla-desktop">
        <svg aria-hidden="true" viewBox="0 0 16 16" class="h-6 w-6 fill-slate-400 group-hover:fill-slate-500 dark:group-hover:fill-slate-300">
          <path d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"></path>
        </svg>
      </a>
    </div>
  </header>

  <!-- Mobile Menu Overlay -->
  <div v-if="isMobileMenuOpen" class="fixed inset-0 z-40 lg:hidden">
    <div class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300" @click="toggleMobileMenu"></div>
    <div class="fixed top-0 left-0 right-0 bg-white dark:bg-slate-900 shadow-lg transform transition-transform duration-300 ease-in-out">
      <div class="flex items-center justify-between px-4 py-5 border-b border-slate-200 dark:border-slate-700">
        <a aria-label="Home page" href="#/" class="flex items-center" @click="toggleMobileMenu">
          <img
            :src="logoLightUrl"
            alt="Sulla Desktop"
            class="h-8 w-auto dark:hidden"
          >
          <img
            :src="logoDarkUrl"
            alt="Sulla Desktop"
            class="hidden h-8 w-auto dark:block"
          >
        </a>
        <button type="button" class="relative" aria-label="Close navigation" @click="toggleMobileMenu">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" class="h-6 w-6 stroke-slate-500">
            <path d="M18 6L6 18M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      <nav class="px-4 py-6 space-y-4">
        <router-link
          to="/Chat"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Chat' ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          Chat
        </router-link>
        <router-link
          to="/Calendar"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Calendar' ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          Calendar
        </router-link>
        <router-link
          to="/Filesystem"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Filesystem' ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          Filesystem
        </router-link>
        <router-link
          to="/Integrations"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Integrations' ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          Integrations
        </router-link>
        <router-link
          to="/Extensions"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Extensions' ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          Extensions
        </router-link>
        <router-link
          v-for="item in extensionMenuItems"
          :key="item.link"
          :to="item.link"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === item.link ? 'text-[#0d0d0d] bg-slate-100 dark:text-white dark:bg-slate-800' : 'text-[#0d0d0d]/60 hover:text-[#0d0d0d] hover:bg-slate-50 dark:text-white/60 dark:hover:text-white dark:hover:bg-slate-800'"
          @click="toggleMobileMenu"
        >
          {{ item.title }}
        </router-link>
      </nav>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { getExtensionService } from '@pkg/agent';

const extensionService = getExtensionService();

defineProps<{
  isDark: boolean;
  toggleTheme: () => void;
}>();

defineEmits<{
  'toggle-left-pane': [];
  'toggle-center-pane': [];
  'toggle-right-pane': [];
}>();

const extensionMenuItems = computed(() => extensionService.getHeaderMenuItems());

const route = useRoute();
const isMobileMenuOpen = ref(false);
const logoLightUrl = new URL('../../../../resources/icons/logo-sulla-desktop-nobg.png', import.meta.url).toString();
const logoDarkUrl = new URL('../../../../resources/icons/logo-sulla-desktop-dark-nobg.png', import.meta.url).toString();

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value;
};
</script>
