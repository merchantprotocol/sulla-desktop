<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { computed, onBeforeMount, onBeforeUnmount, ref, watch } from 'vue';
import { useStore } from 'vuex';

import PrefIcon from '@pkg/components/settings/PrefIcon.vue';
import AccountSection from '@pkg/components/settings/sections/AccountSection.vue';
import AdvancedSection from '@pkg/components/settings/sections/AdvancedSection.vue';
import AppearanceSection from '@pkg/components/settings/sections/AppearanceSection.vue';
import DockerSection from '@pkg/components/settings/sections/DockerSection.vue';
import ExtensionsSection from '@pkg/components/settings/sections/ExtensionsSection.vue';
import FilesSection from '@pkg/components/settings/sections/FilesSection.vue';
import GeneralSection from '@pkg/components/settings/sections/GeneralSection.vue';
import HeartbeatSection from '@pkg/components/settings/sections/HeartbeatSection.vue';
import ModelsSection from '@pkg/components/settings/sections/ModelsSection.vue';
import PersonalitySection from '@pkg/components/settings/sections/PersonalitySection.vue';
import PrivacySection from '@pkg/components/settings/sections/PrivacySection.vue';
import VoiceSection from '@pkg/components/settings/sections/VoiceSection.vue';
import WorkflowsSection from '@pkg/components/settings/sections/WorkflowsSection.vue';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { PREFERENCES_NAV, PreferencesSectionId, resolvePreferencesSection } from '@pkg/utils/preferencesModel';

const props = defineProps<{
  /** Section to open, from a menu, shortcut, link or the agent. Cleared once shown. */
  section?: string;
}>();
const emit = defineEmits<(e: 'section-consumed') => void>();

// Keeps this tab in step with theme changes made anywhere in Sulla.
useTheme();

const store = useStore();
const engine = useEngineSettings();

const SECTIONS: Record<PreferencesSectionId, unknown> = {
  general:     GeneralSection,
  appearance:  AppearanceSection,
  models:      ModelsSection,
  personality: PersonalitySection,
  heartbeat:   HeartbeatSection,
  voice:       VoiceSection,
  workflows:   WorkflowsSection,
  extensions:  ExtensionsSection,
  account:     AccountSection,
  files:       FilesSection,
  privacy:     PrivacySection,
  docker:      DockerSection,
  advanced:    AdvancedSection,
};

// Extra words people search for, so "telemetry" finds Privacy and "whisper" finds Voice.
const KEYWORDS: Record<PreferencesSectionId, string> = {
  general:     'startup login background menu bar icon quit window updates release notes',
  appearance:  'theme color colour dark light mode noir',
  models:      'provider model anthropic openai grok ollama backup fallback retries timeout api key',
  personality: 'name instructions soul system prompt user',
  heartbeat:   'heartbeat interval autonomous',
  voice:       'microphone mic transcription whisper speech voice tts kokoro speaker loopback secretary gateway',
  workflows:   'workers concurrency external events wait',
  extensions:  'permissions hooks integrations use cases activity grants',
  account:     'profile email cloud sign in remote access phone servers master password vault passwords',
  files:       'folders sync finder backups exclusions',
  privacy:     'host access admin administrator telemetry usage',
  docker:      'memory cpu disk rosetta virtual machine vz qemu virtiofs 9p sshfs engine moby containerd path images ' +
    'network port',
  advanced: 'debug logs troubleshooting health extensions experimental vault proxy reset factory',
};

const STORAGE_KEY = 'sulla.preferences.section';
const loaded = ref(false);
const loadFailed = ref(false);
const query = ref('');
const current = ref<PreferencesSectionId>(resolvePreferencesSection(localStorage.getItem(STORAGE_KEY)) ?? 'general');
const version = ref('');
const updateAvailable = ref(false);

watch(current, (id) => {
  localStorage.setItem(STORAGE_KEY, id);
  document.querySelector('.sulla-prefs .main')?.scrollTo({ top: 0 });
});

const nav = computed(() => {
  const q = query.value.trim().toLowerCase();

  return PREFERENCES_NAV
    .map(group => ({
      ...group,
      items: group.items.filter(item => !q || item.label.toLowerCase().includes(q) || KEYWORDS[item.id].includes(q)),
    }))
    .filter(group => group.items.length > 0);
});

const sectionComponent = computed(() => SECTIONS[current.value]);

function go(id: PreferencesSectionId) {
  current.value = id;
}

watch(() => props.section, (name) => {
  if (!name) {
    return;
  }
  const target = resolvePreferencesSection(name);

  if (target) {
    current.value = target;
  }
  emit('section-consumed');
}, { immediate: true });

function onUpdaterState(_event: unknown, state: { currentVersion: string, updateAvailable: boolean }) {
  version.value = state.currentVersion;
  updateAvailable.value = state.updateAvailable;
}

async function load() {
  loaded.value = false;
  try {
    await store.dispatch('credentials/fetchCredentials');
    await store.dispatch('preferences/fetchPreferences');
    await store.dispatch('preferences/fetchLocked');
    loadFailed.value = !!store.getters['preferences/hasError'];
  } catch {
    loadFailed.value = true;
  }
  loaded.value = true;
}

onBeforeMount(() => {
  ipcRenderer.on('updater:state', onUpdaterState);
  void load();
  ipcRenderer.invoke('updater:get-state').then(state => onUpdaterState(null, state)).catch(() => undefined);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('updater:state', onUpdaterState);
  // Closing the tab drops changes still waiting to restart Docker, as closing the window did.
  if (engine.held.value) {
    void engine.discardHeld();
  }
});
</script>

<template>
  <div class="sulla-prefs">
    <div class="body">
      <nav
        class="nav"
        aria-label="Preferences sections"
      >
        <label class="search">
          <PrefIcon name="search" />
          <input
            v-model="query"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
          >
        </label>
        <template
          v-for="(group, gi) in nav"
          :key="gi"
        >
          <div
            v-if="group.title"
            class="grp"
          >
            {{ group.title }}
          </div>
          <div
            v-else-if="gi > 0"
            class="sep"
          />
          <a
            v-for="item in group.items"
            :key="item.id"
            href="#"
            :class="{ on: current === item.id }"
            :aria-current="current === item.id ? 'page' : undefined"
            @click.prevent="go(item.id)"
          >
            <span class="sv"><PrefIcon :name="item.icon" /></span>{{ item.label }}
          </a>
        </template>
        <div
          v-if="!nav.length"
          class="nores"
        >
          No settings match “{{ query }}”.
        </div>
        <div class="foot">
          <div
            v-if="version"
            class="kline"
          >
            <span
              class="dot"
              :class="{ warn: updateAvailable }"
            />
            <span>Sulla Desktop <b>{{ version }}</b></span>
            <span class="r">{{ updateAvailable ? 'Update ready' : 'Latest' }}</span>
          </div>
        </div>
      </nav>

      <main class="main">
        <div class="page narrow">
          <div
            v-if="!loaded"
            class="loading"
          >
            Loading preferences…
          </div>
          <div
            v-else-if="loadFailed"
            class="alert"
          >
            <PrefIcon name="alert" />
            <div class="x">
              <b>Sulla couldn’t load your preferences.</b>
              <span>The settings service didn’t answer. Try again in a moment.</span>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                @click="load"
              >
                Try again
              </button>
            </div>
          </div>
          <component
            :is="sectionComponent"
            v-else
          />
        </div>
      </main>
    </div>

    <div
      v-if="engine.held.value || engine.error.value"
      class="applybar"
      role="status"
    >
      <PrefIcon :name="engine.error.value ? 'alert' : 'restart'" />
      <span
        v-if="engine.error.value"
        class="msg badc"
      >{{ engine.error.value }}</span>
      <span
        v-else
        class="msg"
      >{{ engine.held.value === 'reset'
        ? 'These changes reset the virtual machine. Its data is deleted.'
        : 'These changes restart Docker. Running containers stop for a moment.' }}</span>
      <div class="r">
        <button
          v-if="engine.held.value"
          type="button"
          class="btn ghost"
          :disabled="engine.applying.value"
          @click="engine.discardHeld"
        >
          Discard
        </button>
        <button
          v-if="engine.held.value"
          type="button"
          class="btn pri"
          :disabled="engine.applying.value"
          @click="engine.applyHeld"
        >
          {{ engine.held.value === 'reset' ? 'Apply and reset' : 'Apply and restart' }}
        </button>
        <button
          v-else
          type="button"
          class="btn ghost"
          @click="engine.error.value = ''"
        >
          Dismiss
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
/*
 * Preferences tab styles. Not scoped, so the section components share
 * them, but everything sits under .sulla-prefs so nothing leaks into the
 * other tabs in the main window.
 */
@import '@pkg/assets/styles/sulla-window.scss';

.sulla-prefs {
  @include sulla-window;
}
</style>
