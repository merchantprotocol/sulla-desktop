<template>
  <header class="sh-header sticky top-0 z-50 flex flex-none flex-wrap items-center justify-between px-4 py-5 shadow-md transition duration-500 sm:px-6 lg:px-8">
    <div class="relative flex grow basis-0 items-center">
      <WindowDragLogo :size="28" />
    </div>
    <div class="relative flex basis-0 justify-end gap-6 sm:gap-8">
      <div
        class="relative z-10"
        data-headlessui-state=""
      >
        <label
          id="headlessui-label-_r_9_"
          class="sr-only"
          for="headlessui-listbox-button-_r_a_"
          data-headlessui-state=""
        >Theme</label>
        <button
          class="sh-theme-toggle flex h-6 w-6 items-center justify-center rounded-lg shadow-md ring-1"
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg
            v-if="isDark"
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-4 w-4 fill-sky-400"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 0 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z"
            />
          </svg>
          <svg
            v-else
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-4 w-4 fill-sky-400"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 1 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1 1 1 0 0 1 1-1Z"
            />
          </svg>
        </button>
      </div>
      <button
        v-if="onStop"
        class="sh-quit-btn cursor-pointer flex h-6 px-2 items-center justify-center rounded-lg shadow-md ring-1 text-sm"
        type="button"
        aria-label="Stop Sulla"
        @click="onStop"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          class="h-4 w-4 mr-1"
        >
          <path
            fill-rule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
        Quit
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';

defineProps<{
  isDark:      boolean;
  toggleTheme: () => void;
  onStop?:     () => void;
  homeUrl?:    string;
}>();
</script>

<style lang="scss" scoped>
.sh-header {
  -webkit-app-region: drag;
  app-region: drag;
  background: var(--bg-header, var(--body-bg, #ffffff));
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-default, var(--header-border, #e5e7eb));

  button {
    -webkit-app-region: no-drag;
    app-region: no-drag;
  }
}

.sh-theme-toggle {
  background: var(--bg-surface-hover, var(--input-bg, #f3f4f6));
  --tw-ring-color: var(--border-default, var(--header-border, #e5e7eb));
  color: var(--text-primary, var(--body-text, #1f2937));
}

.sh-quit-btn {
  color: var(--text-secondary, var(--muted, #4b5563));
  background: var(--bg-surface-hover, var(--input-bg, #f3f4f6));
  --tw-ring-color: var(--border-default, var(--header-border, #e5e7eb));

  &:hover {
    background: var(--bg-surface-alt, #e5e7eb);
    color: var(--text-primary, var(--body-text, #1f2937));
  }

  &:active {
    background: var(--bg-surface-alt, #d1d5db);
  }
}

.dark .sh-header {
  background: var(--bg-header, rgba(13, 17, 23, 0.8));
  border-bottom-color: var(--border-default, #30363d);
}

.dark .sh-theme-toggle {
  background: var(--bg-surface-hover, #21262d);
  --tw-ring-color: var(--border-default, #30363d);
  color: var(--text-primary, #e6edf3);
}

.dark .sh-quit-btn {
  color: var(--text-secondary, #8b949e);
  background: var(--bg-surface-hover, #21262d);
  --tw-ring-color: var(--border-default, #30363d);

  &:hover {
    background: var(--bg-surface-alt, #30363d);
    color: var(--text-primary, #e6edf3);
  }
}
</style>
