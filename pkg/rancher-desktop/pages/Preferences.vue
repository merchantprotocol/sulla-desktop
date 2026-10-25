<script lang="ts">
// The window entry reads `layout` off the route's component to pick its layout.
export default { name: 'preferences-window', layout: 'preferences' };
</script>

<script setup lang="ts">
import { computed, onBeforeMount, onBeforeUnmount, ref, watch } from 'vue';
import { useStore } from 'vuex';

import PrefIcon from '@pkg/components/settings/PrefIcon.vue';
import AccountSection from '@pkg/components/settings/sections/AccountSection.vue';
import AdvancedSection from '@pkg/components/settings/sections/AdvancedSection.vue';
import AppearanceSection from '@pkg/components/settings/sections/AppearanceSection.vue';
import DockerSection from '@pkg/components/settings/sections/DockerSection.vue';
import FilesSection from '@pkg/components/settings/sections/FilesSection.vue';
import GeneralSection from '@pkg/components/settings/sections/GeneralSection.vue';
import HeartbeatSection from '@pkg/components/settings/sections/HeartbeatSection.vue';
import KubernetesSection from '@pkg/components/settings/sections/KubernetesSection.vue';
import ModelsSection from '@pkg/components/settings/sections/ModelsSection.vue';
import PersonalitySection from '@pkg/components/settings/sections/PersonalitySection.vue';
import PrivacySection from '@pkg/components/settings/sections/PrivacySection.vue';
import VoiceSection from '@pkg/components/settings/sections/VoiceSection.vue';
import WorkflowsSection from '@pkg/components/settings/sections/WorkflowsSection.vue';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import {
  PREFERENCES_NAV, PreferencesSectionId, resolvePreferencesSection, stepPreferencesSection,
} from '@pkg/utils/preferencesModel';

// Keeps this window in step with theme changes made anywhere in Sulla.
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
  account:     AccountSection,
  files:       FilesSection,
  privacy:     PrivacySection,
  docker:      DockerSection,
  kubernetes:  KubernetesSection,
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
  account:     'profile email cloud sign in remote access phone servers master password vault passwords',
  files:       'folders sync finder backups exclusions',
  privacy:     'host access admin administrator telemetry usage',
  docker:      'memory cpu disk rosetta virtual machine vz qemu virtiofs 9p sshfs engine moby containerd path images ' +
    'network port',
  kubernetes:  'k8s cluster version traefik flannel spin port',
  advanced:    'debug logs troubleshooting health extensions experimental vault wsl proxy reset factory',
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
const kubernetesOn = computed(() => !!engine.settings.value?.kubernetes?.enabled);

function go(id: PreferencesSectionId) {
  current.value = id;
}

function onRoute(_event: unknown, args: { name?: string, direction?: 'forward' | 'back' }) {
  const target = resolvePreferencesSection(args?.name);

  if (target) {
    current.value = target;
  } else if (args?.direction) {
    current.value = stepPreferencesSection(current.value, args.direction);
  }
}

function onUpdaterState(_event: unknown, state: { currentVersion: string, updateAvailable: boolean }) {
  version.value = state.currentVersion;
  updateAvailable.value = state.updateAvailable;
}

onBeforeMount(async() => {
  ipcRenderer.on('route', onRoute);
  ipcRenderer.on('updater:state', onUpdaterState);
  try {
    await store.dispatch('credentials/fetchCredentials');
    await store.dispatch('preferences/fetchPreferences');
    await store.dispatch('preferences/fetchLocked');
    loadFailed.value = !!store.getters['preferences/hasError'];
  } catch {
    loadFailed.value = true;
  }
  loaded.value = true;
  ipcRenderer.invoke('updater:get-state').then(state => onUpdaterState(null, state)).catch(() => undefined);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('route', onRoute);
  ipcRenderer.removeListener('updater:state', onUpdaterState);
});

function reload() {
  window.location.reload();
}
</script>

<template>
  <div class="sulla-prefs">
    <div class="titlebar">
      <div class="wt">
        Preferences
      </div>
    </div>
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
            <span
              v-if="item.id === 'kubernetes' && loaded"
              class="cnt"
            >{{ kubernetesOn ? 'On' : 'Off' }}</span>
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
              <span>The settings service didn’t answer. Reload to try again.</span>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                @click="reload"
              >
                Reload
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
        ? 'These changes reset Kubernetes. Its workloads are deleted.'
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
 * Preferences window styles. Not scoped, so the section components share
 * them, but everything sits under .sulla-prefs so nothing leaks into the
 * other screens in this bundle. Colours come from the active theme; Noir
 * Light and Noir Dark get the exact approved palette.
 */
.sulla-prefs {
  --paper: var(--nx-paper, var(--bg-page));
  --paper-2: var(--bg-surface-alt);
  --card-solid: var(--nx-surface, var(--bg-surface));
  --card: color-mix(in srgb, var(--card-solid) 82%, transparent);
  --text: var(--nx-ink, var(--text-primary));
  --muted: var(--nx-read-2, var(--text-secondary));
  --dim: var(--nx-read-3, var(--text-muted));
  --line: color-mix(in srgb, var(--text) 9%, transparent);
  --line-2: color-mix(in srgb, var(--text) 15%, transparent);
  --accent: var(--nx-accent, var(--accent-primary));
  --accent-2: color-mix(in srgb, var(--accent) 78%, var(--text));
  --accent-soft: color-mix(in srgb, var(--accent) 11%, transparent);
  --accent-line: color-mix(in srgb, var(--accent) 34%, transparent);
  --on-accent: var(--text-on-accent, #fff);
  --ok: var(--nx-success, var(--status-success));
  --ok-soft: color-mix(in srgb, var(--ok) 13%, transparent);
  --warn: var(--nx-warning, var(--status-warning));
  --warn-soft: color-mix(in srgb, var(--warn) 14%, transparent);
  --bad: var(--nx-danger, var(--status-error));
  --bad-soft: color-mix(in srgb, var(--bad) 12%, transparent);
  --idle: var(--dim);
  --idle-soft: color-mix(in srgb, var(--dim) 16%, transparent);
  --ink-05: color-mix(in srgb, var(--text) 5%, transparent);
  --ink-08: color-mix(in srgb, var(--text) 8%, transparent);
  --nav-bg: color-mix(in srgb, var(--card-solid) 55%, transparent);
  --top-bg: color-mix(in srgb, var(--card-solid) 40%, transparent);
  --glow-1: color-mix(in srgb, var(--accent) 10%, transparent);
  --glow-2: color-mix(in srgb, var(--accent) 6%, transparent);
  --tint: 26, 35, 50;
  --shadow: 0 1px 2px rgba(var(--tint), .04), 0 10px 30px -12px rgba(var(--tint), .12);
  --shadow-sm: 0 1px 1px rgba(var(--tint), .04), 0 2px 8px -2px rgba(var(--tint), .08);
  --shadow-lg: 0 2px 4px rgba(var(--tint), .06), 0 30px 60px -20px rgba(var(--tint), .28);
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: var(--font-mono, "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  --display: var(--font-display, "Playfair Display", Georgia, serif);
  --r: 12px;

  html.theme-noir-light & {
    --muted: #5b6778;
    --dim: #8a94a3;
    --paper-2: #eaf0f6;
    --accent: #3a7fa0;
    --accent-2: #2f6a86;
    --ok: #1f9d55;
    --warn: #d98a0a;
    --bad: #d9403a;
    --line: rgba(26, 35, 50, .09);
    --line-2: rgba(26, 35, 50, .14);
    --card: rgba(255, 255, 255, .82);
    --nav-bg: rgba(255, 255, 255, .55);
    --top-bg: rgba(255, 255, 255, .4);
  }
  html.dark & {
    --tint: 0, 0, 0;
    --card: color-mix(in srgb, var(--card-solid) 88%, transparent);
    --nav-bg: color-mix(in srgb, var(--card-solid) 70%, transparent);
    --top-bg: color-mix(in srgb, var(--paper) 70%, transparent);
    --glow-1: color-mix(in srgb, var(--accent) 13%, transparent);
  }
  html.theme-noir-dark & {
    --card-solid: #0b1220;
    --paper-2: #0e1626;
    --card: rgba(11, 18, 32, .86);
  }

  height: 100vh;
  display: grid;
  grid-template-rows: 40px minmax(0, 1fr);
  overflow: hidden;
  position: relative;
  background: var(--paper);
  background-image:
    radial-gradient(900px 500px at 15% -10%, var(--glow-1), transparent 60%),
    radial-gradient(700px 400px at 100% 0%, var(--glow-2), transparent 55%);
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.45;
  font-feature-settings: "tnum" 1, "cv11" 1;
  -webkit-font-smoothing: antialiased;

  *, *::before, *::after { box-sizing: border-box; }
  a {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  button {
    font: inherit;
    color: inherit;
    cursor: pointer;
    // The app's global .btn/button rule sets a 40px min-height.
    min-height: 0;
  }
  input, textarea, select {
    font: inherit;
    color: inherit;
  }
  h1, h2, h3, p { margin: 0; }
  .pi {
    display: inline-grid;
    place-items: center;
  }
  .pi svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* ── Window frame ── */
  .titlebar {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--top-bg);
    backdrop-filter: blur(14px);
    -webkit-app-region: drag;
    user-select: none;
  }
  .titlebar .wt {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--muted);
    white-space: nowrap;
  }
  .body {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    min-height: 0;
  }

  /* ── Sidebar ── */
  .nav {
    min-height: 0;
    overflow-y: auto;
    padding: 14px 12px 12px;
    border-right: 1px solid var(--line);
    background: var(--nav-bg);
    backdrop-filter: blur(14px);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    margin: 0 0 10px;
    border: 1px solid var(--line-2);
    border-radius: 9px;
    background: var(--card-solid);
    color: var(--dim);
    font-size: 12.5px;
  }
  .nav .search:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .nav .search .pi {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .nav .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent !important;
    font-size: 12.5px;
    color: var(--text) !important;
    padding: 0;
    height: auto;
  }
  .nav .search input::placeholder { color: var(--dim); }
  .nav .search input::-webkit-search-cancel-button { display: none; }
  .nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    color: var(--muted);
    font-weight: 500;
  }
  .nav a .sv {
    display: grid;
    width: 16px;
    height: 16px;
    flex: none;
    opacity: .8;
  }
  .nav a .sv .pi {
    width: 16px;
    height: 16px;
  }
  .nav a:hover {
    background: var(--ink-05);
    color: var(--text);
  }
  .nav a.on {
    background: var(--accent-soft);
    color: var(--accent-2);
    font-weight: 600;
  }
  .nav a.on .sv { opacity: 1; }
  .nav a .cnt {
    margin-left: auto;
    font-size: 11px;
    font-weight: 600;
    color: var(--dim);
  }
  .nav .grp {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 12px 10px 4px;
  }
  .nav .sep {
    height: 1px;
    background: var(--line);
    margin: 10px 8px;
  }
  .nav .nores {
    padding: 8px 10px;
    color: var(--dim);
    font-size: 12px;
  }
  .nav .foot {
    margin-top: auto;
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kline {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--card);
    font-size: 12px;
    color: var(--muted);
  }
  .kline span { white-space: nowrap; }
  .kline b {
    color: var(--text);
    font-weight: 600;
  }
  .kline .r {
    margin-left: auto;
    color: var(--accent-2);
    font-weight: 500;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px var(--ok-soft);
    flex: none;
    display: inline-block;
  }
  .dot.off {
    background: var(--idle);
    box-shadow: 0 0 0 3px var(--idle-soft);
  }
  .dot.warn {
    background: var(--warn);
    box-shadow: 0 0 0 3px var(--warn-soft);
  }
  .dot.bad {
    background: var(--bad);
    box-shadow: 0 0 0 3px var(--bad-soft);
  }

  /* ── Main ── */
  .main {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }
  .page {
    padding: 26px 32px 48px;
    max-width: 1180px;
  }
  .page.narrow { max-width: 860px; }
  .loading {
    padding: 40px 0;
    color: var(--dim);
  }
  .ph {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 18px;
  }
  .ph h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -.01em;
  }
  .ph p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .ph .r {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
    flex: none;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px;
    border-radius: 8px;
    border: 1px solid var(--line-2);
    background: var(--card-solid);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
    box-shadow: 0 1px 1px rgba(var(--tint), .03);
    white-space: nowrap;
    line-height: 1.45;
  }
  .btn:hover {
    border-color: var(--accent-line);
    color: var(--accent-2);
  }
  .btn.pri {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .btn.pri:hover {
    background: var(--accent-2);
    color: var(--on-accent);
  }
  .btn.danger {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 35%, transparent);
  }
  .btn.danger:hover { background: var(--bad-soft); }
  .btn.sm {
    padding: 3px 9px;
    font-size: 11.5px;
    border-radius: 7px;
  }
  .btn.ghost {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--muted);
  }
  .btn.ghost:hover {
    background: var(--ink-05);
    color: var(--text);
  }
  .btn .pi {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .btn[disabled] {
    opacity: .45;
    pointer-events: none;
  }
  .btn.ico {
    width: 26px;
    padding: 3px 0;
    justify-content: center;
  }

  .card {
    background: var(--card);
    backdrop-filter: blur(12px);
    border: 1px solid var(--line);
    border-radius: var(--r);
    box-shadow: var(--shadow);
    margin-bottom: 16px;
  }
  .card-h {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px 12px;
    border-bottom: 1px solid var(--line);
  }
  .card-h h2 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 650;
  }
  .card-h p {
    margin: 2px 0 0;
    color: var(--dim);
    font-size: 12px;
  }
  .card-h .r {
    margin-left: auto;
    display: flex;
    gap: 6px;
    align-items: center;
    flex: none;
  }
  .card.off .set, .set.off { opacity: .5; }
  .card > .note {
    padding: 11px 18px;
    border-top: 1px solid var(--line);
    color: var(--dim);
    font-size: 12px;
  }
  .card > .note.badc { color: var(--bad); }

  /* setting rows */
  .set {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 13px 18px;
    border-top: 1px solid var(--line);
  }
  .card-h + .set, .set:first-child { border-top: 0; }
  .set .l {
    flex: 1;
    min-width: 0;
  }
  .set .l b {
    display: block;
    font-weight: 600;
    font-size: 13px;
  }
  .set .l small {
    display: block;
    color: var(--dim);
    font-size: 12px;
    margin-top: 2px;
  }
  .set .c {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .set.top { align-items: flex-start; }
  .set.col {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .set.col > .c {
    flex: 1;
    flex-direction: column;
    align-items: stretch;
  }
  .set .val {
    font-weight: 600;
    font-size: 12.5px;
    min-width: 56px;
    text-align: right;
  }
  .set > .c:only-child { margin-left: auto; }
  .set.col > .c:only-child { margin-left: 0; }
  .more {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    padding: 11px 18px;
    border: 0;
    border-top: 1px solid var(--line);
    background: transparent;
    color: var(--accent-2);
    font-weight: 500;
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }
  .more .pi {
    width: 13px;
    height: 13px;
    transition: transform .15s;
  }
  .more.open .pi { transform: rotate(90deg); }
  .adv {
    background: color-mix(in srgb, var(--paper-2) 55%, transparent);
    border-top: 1px solid var(--line);
  }
  .card > .adv:last-child { border-radius: 0 0 var(--r) var(--r); }
  .adv .set { padding-left: 34px; }

  .tog {
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: var(--line-2);
    position: relative;
    flex: none;
    border: 0;
    padding: 0;
  }
  .tog::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
    transition: left .15s;
  }
  .tog.on { background: var(--accent); }
  .tog.on::after { left: 16px; }
  .tog:disabled {
    opacity: .45;
    cursor: default;
  }
  /* The themes restyle every input and select with !important; these keep the approved look. */
  .sel {
    height: 30px;
    padding: 0 30px 0 10px;
    border: 1px solid var(--line-2) !important;
    border-radius: 8px;
    font-size: 12.5px;
    appearance: none;
    -webkit-appearance: none;
    outline: 0;
    color: var(--text) !important;
    min-width: 180px;
    max-width: 280px;
    background-color: var(--card-solid) !important;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--dim) 50%),
      linear-gradient(135deg, var(--dim) 50%, transparent 50%) !important;
    background-position: calc(100% - 15px) 13px, calc(100% - 10px) 13px !important;
    background-size: 5px 5px !important;
    background-repeat: no-repeat !important;
  }
  .sel:disabled, .inp:disabled { opacity: .5; }
  .inp {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2) !important;
    border-radius: 8px;
    background: var(--card-solid) !important;
    font-size: 12.5px;
    outline: 0;
    width: 220px;
    color: var(--text) !important;
  }
  .inp.sm { width: 90px; }
  .inp.wide { width: 100%; }
  .inp:focus, .sel:focus, .ta:focus {
    border-color: var(--accent) !important;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .ta {
    width: 100%;
    min-height: 96px;
    padding: 10px 11px;
    border: 1px solid var(--line-2) !important;
    border-radius: 9px;
    background: var(--card-solid) !important;
    font: 12px/1.55 var(--mono);
    outline: 0;
    resize: vertical;
    color: var(--text) !important;
  }
  .range {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .range .trk {
    position: relative;
    width: 260px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-2);
  }
  .range .trk i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    background: var(--accent);
  }
  .range .trk b {
    position: absolute;
    top: 50%;
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
    border-radius: 50%;
    background: #fff;
    border: 1px solid var(--line-2);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
    pointer-events: none;
  }
  .range .trk input {
    position: absolute;
    inset: -8px -8px;
    width: calc(100% + 16px);
    height: 20px;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .range-off {
    opacity: .5;
    pointer-events: none;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    width: 260px;
    font-size: 10.5px;
    color: var(--dim);
    margin-top: 6px;
  }
  .choice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card-solid);
    cursor: pointer;
    outline: 0;
  }
  .opt:hover, .opt:focus-visible { border-color: var(--accent-line); }
  .opt.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .opt .rd {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1.5px solid var(--line-2);
    flex: none;
    position: relative;
  }
  .opt.on .rd { border-color: var(--accent); }
  .opt.on .rd::after {
    content: "";
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    background: var(--accent);
  }
  .opt .t {
    flex: 1;
    min-width: 0;
  }
  .opt .t b {
    display: block;
    font-weight: 600;
  }
  .opt .t small {
    display: block;
    color: var(--dim);
    font-size: 12px;
  }
  .opt .rec {
    font-size: 11.5px;
    color: var(--accent-2);
    font-weight: 600;
  }
  .opt.dis {
    opacity: .5;
    cursor: default;
  }
  .lst {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--card-solid);
    width: 100%;
  }
  .lst > div {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
  }
  .lst > div:first-child { border-top: 0; }
  .lst .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .lst .r {
    margin-left: auto;
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--dim);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .lst .r .sel, .lst .r .btn { color: var(--text); }
  .lst .r .btn.danger { color: var(--bad); }
  .lst .r .sel { min-width: 140px; }
  .lst .grow {
    flex: 1;
    min-width: 0;
  }
  .lst .grow small {
    display: block;
    color: var(--dim);
    font-size: 12px;
  }
  .lst .empty-row { color: var(--dim); }
  .meter {
    display: flex;
    gap: 2px;
    align-items: flex-end;
    height: 16px;
  }
  .meter i {
    width: 4px;
    border-radius: 1px;
    background: var(--ok);
  }
  .meter i.o { background: var(--line-2); }
  .link {
    color: var(--accent-2);
    font-weight: 500;
    border: 0;
    background: none;
    padding: 0;
  }
  .link:hover { text-decoration: underline; }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); }
  .dimc { color: var(--dim); }
  .okc { color: var(--ok); }
  .warnc { color: var(--warn); }
  .badc { color: var(--bad); }
  .k {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .soon {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--idle-soft);
    color: var(--dim);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .seg {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: 9px;
    background: var(--card-solid);
  }
  .seg button {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    padding: 3px 10px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--muted);
  }
  .seg button .pi {
    width: 13px;
    height: 13px;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent-2);
    font-weight: 600;
  }
  .seg button:disabled {
    opacity: .5;
    cursor: default;
  }
  .code {
    font: 12px var(--mono);
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--paper-2);
    overflow: hidden;
    margin-top: 3px;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width .3s;
  }

  /* theme cards */
  .themes {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 12px;
    padding: 16px 18px;
  }
  .theme {
    border: 1px solid var(--line);
    border-radius: 11px;
    padding: 8px;
    background: var(--card-solid);
    cursor: pointer;
    text-align: left;
  }
  .theme.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .theme .pv {
    height: 62px;
    border-radius: 7px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    overflow: hidden;
    border: 1px solid var(--line);
  }
  .theme .pv span { position: relative; }
  .theme .pv span::before {
    content: "";
    position: absolute;
    left: 8px;
    top: 9px;
    width: 28px;
    height: 5px;
    border-radius: 3px;
    background: var(--a);
  }
  .theme .pv span::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    top: 22px;
    height: 26px;
    border-radius: 4px;
    background: var(--s);
  }
  .theme b {
    display: block;
    margin: 8px 2px 0;
    font-size: 12.5px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 13px 16px;
    border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
    background: var(--bad-soft);
    border-radius: var(--r);
    margin-bottom: 16px;
  }
  .alert.warn {
    border-color: color-mix(in srgb, var(--warn) 34%, transparent);
    background: var(--warn-soft);
  }
  .alert.info {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  .alert > .pi {
    width: 18px;
    height: 18px;
    flex: none;
    color: var(--bad);
    margin-top: 1px;
  }
  .alert.warn > .pi { color: var(--warn); }
  .alert.info > .pi { color: var(--accent-2); }
  .alert .x {
    flex: 1;
    min-width: 0;
  }
  .alert .x b {
    display: block;
    font-weight: 650;
  }
  .alert .x span { color: var(--muted); }
  .alert .r {
    display: flex;
    gap: 6px;
    flex: none;
    align-items: center;
  }
  .card .alert {
    margin: 0;
    border-radius: 0;
    border-width: 0 0 1px;
  }

  /* diff (prompt edit review) */
  .diff {
    font: 12px/1.7 var(--mono);
    background: var(--card-solid);
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: auto;
    max-height: 360px;
  }
  .diff .dl {
    display: flex;
    white-space: pre-wrap;
    padding-right: 16px;
  }
  .diff .dl i {
    width: 34px;
    text-align: center;
    color: var(--dim);
    font-style: normal;
    flex: none;
    user-select: none;
  }
  .diff .dl.add { background: color-mix(in srgb, var(--ok) 11%, transparent); }
  .diff .dl.add i { color: var(--ok); }
  .diff .dl.del { background: color-mix(in srgb, var(--bad) 10%, transparent); }
  .diff .dl.del i { color: var(--bad); }

  /* modal (Kubernetes setup) */
  .scrim {
    position: absolute;
    inset: 40px 0 0 0;
    background: rgba(8, 12, 20, .38);
    backdrop-filter: blur(2px);
    display: grid;
    place-items: center;
    z-index: 20;
  }
  .modal {
    width: 600px;
    max-width: calc(100vw - 48px);
    background: var(--card-solid);
    border: 1px solid var(--line-2);
    border-radius: 16px;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  .modal .mh { padding: 20px 24px 6px; }
  .modal .mh h2 {
    margin: 0;
    font-family: var(--display);
    font-size: 22px;
  }
  .modal .mh p {
    margin: 4px 0 0;
    color: var(--muted);
  }
  .steps {
    display: flex;
    padding: 14px 24px 4px;
  }
  .steps div {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--dim);
  }
  .steps div i {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--line-2);
    display: grid;
    place-items: center;
    font-style: normal;
    font-size: 11px;
    font-weight: 600;
    flex: none;
  }
  .steps div.on {
    color: var(--text);
    font-weight: 600;
  }
  .steps div.on i {
    border-color: var(--accent);
    color: var(--accent-2);
    background: var(--accent-soft);
  }
  .steps div.done i {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .steps div::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line-2);
    margin: 0 10px;
  }
  .steps div:last-child::after { display: none; }
  .modal .mb { padding: 14px 24px 18px; }
  .modal .mf {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 24px;
    border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--paper-2) 50%, transparent);
  }
  .modal .mf .r {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  .modal .lst > div { padding: 10px 12px; }
  .prog {
    margin: 0;
    padding: 0;
  }
  .prog li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 0;
    border-top: 1px solid var(--line);
    list-style: none;
  }
  .prog li:first-child { border-top: 0; }
  .prog .s {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    border: 1.5px solid var(--line-2);
  }
  .prog .s .pi {
    width: 11px;
    height: 11px;
  }
  .prog li.done .s {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .prog li.run .s {
    border-color: var(--accent);
    border-top-color: transparent;
    animation: sulla-prefs-spin 1s linear infinite;
  }
  .prog li .t2 {
    margin-left: auto;
    color: var(--dim);
    font-size: 12px;
  }
  .big-ok {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 0 12px;
  }
  .big-ok .ic {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ok-soft);
    color: var(--ok);
  }
  .big-ok .ic .pi {
    width: 22px;
    height: 22px;
  }

  /* pending-restart bar */
  .applybar {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(calc(-50% + 118px));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px 10px 16px;
    max-width: min(760px, calc(100vw - 280px));
    border: 1px solid var(--line-2);
    border-radius: 12px;
    background: var(--card-solid);
    box-shadow: var(--shadow-lg);
    z-index: 10;
  }
  .applybar > .pi {
    width: 16px;
    height: 16px;
    color: var(--accent-2);
    flex: none;
  }
  .applybar .msg {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
  }
  .applybar .r {
    display: flex;
    gap: 8px;
    flex: none;
  }
}

@keyframes sulla-prefs-spin {
  to { transform: rotate(360deg); }
}
</style>
