<template>
  <header class="sticky top-0 z-50 flex flex-none flex-wrap items-center justify-between bg-page pl-20 pr-4 py-5 shadow-md transition duration-500 backdrop-blur-sm sm:pr-6 lg:pr-8 app-titlebar">
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
          :class="route.path === '/Chat' ? 'text-content' : 'text-content-secondary hover:text-content'"
        >
          Chat
        </router-link>
        <router-link
          to="/Calendar"
          class="text-sm font-semibold"
          :class="route.path === '/Calendar' ? 'text-content' : 'text-content-secondary hover:text-content'"
        >
          Calendar
        </router-link>
        <router-link
          to="/Integrations"
          class="text-sm font-semibold"
          :class="route.path === '/Integrations' ? 'text-content' : 'text-content-secondary hover:text-content'"
        >
          Integrations
        </router-link>
        <router-link
          to="/Extensions"
          class="text-sm font-semibold"
          :class="route.path === '/Extensions' ? 'text-content' : 'text-content-secondary hover:text-content'"
        >
          Extensions
        </router-link>
        <router-link
          v-for="item in extensionMenuItems"
          :key="item.link"
          :to="item.link"
          class="text-sm font-semibold"
          :class="route.path === item.link ? 'text-content' : 'text-content-secondary hover:text-content'"
        >
          {{ item.title }}
        </router-link>
      </nav>
    </div>
    <div class="relative flex basis-0 justify-end gap-6 sm:gap-8">
      <div v-if="route.path === '/Filesystem'" class="flex gap-2">
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5"
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
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5"
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
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5"
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
      <div class="relative z-10">
        <label class="sr-only">Theme</label>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1 shadow-black/5 ring-black/5"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 1 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z" />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 fill-sky-400">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 0 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1Z" />
          </svg>
        </button>
      </div>
    </div>
  </header>

  <!-- Mobile Menu Overlay -->
  <div v-if="isMobileMenuOpen" class="fixed inset-0 z-40 lg:hidden">
    <div class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300" @click="toggleMobileMenu"></div>
    <div class="fixed top-0 left-0 right-0 bg-page shadow-lg transform transition-transform duration-300 ease-in-out">
      <div class="flex items-center justify-between px-4 py-5 border-b border-edge">
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
          :class="route.path === '/Chat' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Chat
        </router-link>
        <router-link
          to="/Calendar"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Calendar' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Calendar
        </router-link>
        <router-link
          to="/Integrations"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Integrations' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Integrations
        </router-link>
        <router-link
          to="/Extensions"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === '/Extensions' ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
          @click="toggleMobileMenu"
        >
          Extensions
        </router-link>
        <router-link
          v-for="item in extensionMenuItems"
          :key="item.link"
          :to="item.link"
          class="block py-3 px-4 text-base font-semibold rounded-lg transition-colors"
          :class="route.path === item.link ? 'text-content bg-surface' : 'text-content-secondary hover:text-content hover:bg-surface'"
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
