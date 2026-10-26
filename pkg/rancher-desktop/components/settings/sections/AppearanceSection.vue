<script setup lang="ts">
import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefRow from '../PrefRow.vue';

import { useTheme, availableThemes, type ThemeScheme } from '@pkg/composables/useTheme';

const { currentTheme, currentScheme, setScheme, setTheme } = useTheme();

// Preview swatches: accent and surface for the light half, then the dark half.
const SCHEMES: { scheme: ThemeScheme, label: string, light: [string, string], dark: [string, string] }[] = [
  { scheme: 'noir', label: 'Noir', light: ['#3a7fa0', '#ffffff'], dark: ['#5096b3', '#070d1a'] },
  { scheme: 'protocol', label: 'Protocol', light: ['#0ea5e9', '#ffffff'], dark: ['#5096b3', '#161b22'] },
  { scheme: 'ocean', label: 'Ocean', light: ['#0e7490', '#f0fbff'], dark: ['#22d3ee', '#0b2530'] },
  { scheme: 'nord', label: 'Nord', light: ['#5e81ac', '#eceff4'], dark: ['#88c0d0', '#3b4252'] },
  { scheme: 'default', label: 'Default', light: ['#2563eb', '#ffffff'], dark: ['#60a5fa', '#1f2937'] },
];

/** CSS for one half of a theme preview: accent bar, surface block and page colour. */
function swatch(scheme: ThemeScheme, colors: [string, string], noirPage: string, page: string) {
  return { '--a': colors[0], '--s': colors[1], background: scheme === 'noir' ? noirPage : page };
}

const mode = computed(() => availableThemes.find(t => t.id === currentTheme.value)?.mode ?? 'dark');

function hasMode(target: 'light' | 'dark') {
  return availableThemes.some(t => t.scheme === currentScheme.value && t.mode === target);
}

function setMode(target: 'light' | 'dark') {
  const theme = availableThemes.find(t => t.scheme === currentScheme.value && t.mode === target);

  if (theme) {
    setTheme(theme.id);
  }
}
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>Appearance</h1>
        <p>Colors and light or dark mode.</p>
      </div>
    </div>

    <PrefCard title="Theme">
      <div class="themes">
        <button
          v-for="theme in SCHEMES"
          :key="theme.scheme"
          type="button"
          class="theme"
          :class="{ on: currentScheme === theme.scheme }"
          :aria-pressed="currentScheme === theme.scheme"
          @click="setScheme(theme.scheme)"
        >
          <div class="pv">
            <span :style="swatch(theme.scheme, theme.light, '#f4f7fb', '#eef2f6')" />
            <span :style="swatch(theme.scheme, theme.dark, '#01030a', '#0d1117')" />
          </div>
          <b>{{ theme.label }}</b>
        </button>
      </div>
    </PrefCard>

    <PrefCard title="Mode">
      <PrefRow title="Light or dark">
        <div class="seg">
          <button
            type="button"
            :class="{ on: mode === 'light' }"
            :disabled="!hasMode('light')"
            @click="setMode('light')"
          >
            <PrefIcon name="sun" />Light
          </button>
          <button
            type="button"
            :class="{ on: mode === 'dark' }"
            :disabled="!hasMode('dark')"
            @click="setMode('dark')"
          >
            <PrefIcon name="moon" />Dark
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
          >
            Match Mac
          </button>
        </div>
        <span class="soon">Match Mac coming soon</span>
      </PrefRow>
    </PrefCard>
  </div>
</template>
