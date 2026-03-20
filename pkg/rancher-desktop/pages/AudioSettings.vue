<template>
  <div class="audio-settings">
    <!-- Header -->
    <div class="audio-header">
      <h1>Audio Settings</h1>
    </div>

    <!-- Main content with sidebar -->
    <div class="audio-content">
      <!-- Sidebar navigation -->
      <nav class="audio-nav">
        <div
          v-for="item in navItems"
          :key="item.id"
          class="nav-item"
          :class="{ active: currentNav === item.id }"
          @click="currentNav = item.id"
        >
          {{ item.name }}
        </div>
      </nav>

      <!-- Content area -->
      <div class="audio-body">
        <!-- Overview Tab -->
        <div
          v-if="currentNav === 'overview'"
          class="tab-content"
        >
          <h2>Audio Configuration</h2>
          <p class="description">
            Overview of your audio settings for speech-to-text and text-to-speech.
          </p>

          <!-- API Key Status -->
          <div class="setting-section">
            <h3>ElevenLabs Connection</h3>
            <div class="status-row">
              <span class="status-label">API Key:</span>
              <span
                class="status-badge"
                :class="apiKeyConnected ? 'badge-success' : 'badge-warning'"
              >
                {{ apiKeyConnected ? 'Connected' : 'Not configured' }}
              </span>
            </div>
            <p
              v-if="!apiKeyConnected"
              class="description"
            >
              Add your ElevenLabs API key in Integrations to enable audio features.
            </p>
          </div>

          <!-- Current Settings Summary -->
          <div class="setting-section">
            <h3>Active Configuration</h3>
            <div class="summary-grid">
              <div class="summary-item">
                <span class="summary-label">Transcription Model</span>
                <span class="summary-value">{{ transcriptionModel || 'scribe_v1 (default)' }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">TTS Voice</span>
                <span class="summary-value">{{ ttsVoiceName || 'Not selected' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Transcription Tab -->
        <div
          v-if="currentNav === 'transcription'"
          class="tab-content"
        >
          <h2>Transcription</h2>
          <p class="description">
            Configure the speech-to-text model used when you record audio via the microphone button.
          </p>

          <div class="setting-section">
            <h3>Provider</h3>
            <select
              v-model="transcriptionProvider"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </div>

          <div class="setting-section">
            <h3>Model</h3>
            <select
              v-model="transcriptionModel"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="scribe_v1">Scribe v1 (default)</option>
              <option value="scribe_v1_experimental">Scribe v1 Experimental</option>
            </select>
            <p class="description">
              Scribe v1 is ElevenLabs' production speech-to-text model with broad language support.
            </p>
          </div>
        </div>

        <!-- Voice Tab -->
        <div
          v-if="currentNav === 'voice'"
          class="tab-content"
        >
          <h2>Text-to-Speech Voice</h2>
          <p class="description">
            Select the voice Sulla will use when speaking responses aloud.
          </p>

          <div class="setting-section">
            <h3>Provider</h3>
            <select
              v-model="ttsProvider"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </div>

          <div class="setting-section">
            <h3>Voice</h3>
            <div class="voice-select-row">
              <select
                v-model="ttsVoice"
                class="setting-select"
                :disabled="loadingVoices"
                @change="saveSettings"
              >
                <option value="">Select a voice...</option>
                <option
                  v-for="voice in voices"
                  :key="voice.value"
                  :value="voice.value"
                >
                  {{ voice.label }}
                  <template v-if="voice.description"> ({{ voice.description }})</template>
                </option>
              </select>
              <button
                class="refresh-btn"
                :disabled="loadingVoices"
                @click="fetchVoices"
              >
                {{ loadingVoices ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
            <p
              v-if="!apiKeyConnected"
              class="description warning"
            >
              Configure your ElevenLabs API key in Integrations to load available voices.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useTheme } from '../composables/useTheme';

// Initialize theme
useTheme();

const navItems = [
  { id: 'overview', name: 'Overview' },
  { id: 'transcription', name: 'Transcription' },
  { id: 'voice', name: 'Voice' },
];

const currentNav = ref('overview');

// Settings state
const apiKeyConnected = ref(false);
const transcriptionProvider = ref('elevenlabs');
const transcriptionModel = ref('scribe_v1');
const ttsProvider = ref('elevenlabs');
const ttsVoice = ref('');
const ttsVoiceName = ref('');

// Voices
const voices = ref<{ value: string; label: string; description?: string }[]>([]);
const loadingVoices = ref(false);

async function loadSettings(): Promise<void> {
  try {
    transcriptionProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionProvider', 'elevenlabs');
    transcriptionModel.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionModel', 'scribe_v1');
    ttsProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsProvider', 'elevenlabs');
    ttsVoice.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoice', '');
    ttsVoiceName.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoiceName', '');
  } catch (err) {
    console.error('[AudioSettings] Failed to load settings:', err);
  }
}

async function saveSettings(): Promise<void> {
  try {
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionProvider', transcriptionProvider.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionModel', transcriptionModel.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsProvider', ttsProvider.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoice', ttsVoice.value);

    // Store the display name of the selected voice
    const selected = voices.value.find(v => v.value === ttsVoice.value);
    ttsVoiceName.value = selected?.label || '';
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoiceName', ttsVoiceName.value);
  } catch (err) {
    console.error('[AudioSettings] Failed to save settings:', err);
  }
}

async function checkApiKey(): Promise<void> {
  try {
    const result = await ipcRenderer.invoke('integration-get-value', 'elevenlabs', 'api_key');
    apiKeyConnected.value = !!(result?.value);
  } catch {
    apiKeyConnected.value = false;
  }
}

async function fetchVoices(): Promise<void> {
  if (loadingVoices.value) return;
  loadingVoices.value = true;

  try {
    const result = await ipcRenderer.invoke('integration-get-value', 'elevenlabs', 'api_key');
    const apiKey = result?.value;

    if (!apiKey) {
      voices.value = getStaticVoices();
      return;
    }

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) {
      voices.value = getStaticVoices();
      return;
    }

    const body = await response.json() as { voices?: { voice_id: string; name: string; category?: string }[] };

    if (body.voices && body.voices.length > 0) {
      voices.value = body.voices.map(v => ({
        value:       v.voice_id,
        label:       v.name,
        description: v.category,
      }));
    } else {
      voices.value = getStaticVoices();
    }
  } catch {
    voices.value = getStaticVoices();
  } finally {
    loadingVoices.value = false;
  }
}

function getStaticVoices(): { value: string; label: string; description?: string }[] {
  return [
    { value: 'Rachel',  label: 'Rachel',  description: 'premade' },
    { value: 'Drew',    label: 'Drew',    description: 'premade' },
    { value: 'Clyde',   label: 'Clyde',   description: 'premade' },
    { value: 'Paul',    label: 'Paul',    description: 'premade' },
    { value: 'Domi',    label: 'Domi',    description: 'premade' },
    { value: 'Dave',    label: 'Dave',    description: 'premade' },
    { value: 'Fin',     label: 'Fin',     description: 'premade' },
    { value: 'Sarah',   label: 'Sarah',   description: 'premade' },
  ];
}

onMounted(async() => {
  await loadSettings();
  await checkApiKey();
  await fetchVoices();
});
</script>

<style lang="scss" scoped>
.audio-settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-page, var(--body-bg));
  color: var(--text-primary, var(--body-text));
}

.audio-header {
  height: 3rem;
  font-size: var(--fs-heading);
  line-height: 2rem;
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  width: 100%;
  border-bottom: 1px solid var(--border-default, var(--header-border));

  h1 {
    flex: 1;
    margin: 0;
    font-size: inherit;
    font-weight: normal;
  }
}

.audio-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.audio-nav {
  width: 200px;
  border-right: 1px solid var(--border-default, var(--header-border));
  padding-top: 0.75rem;
  flex-shrink: 0;

  .nav-item {
    font-size: var(--fs-heading);
    line-height: 1.75rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    user-select: none;
    color: var(--text-muted, var(--muted));
    transition: background 0.15s, color 0.15s;

    &:hover {
      background: var(--bg-surface-hover, var(--nav-active));
      color: var(--text-primary, var(--body-text));
    }

    &.active {
      background: var(--bg-active, var(--primary-light-bg, rgba(59, 130, 246, 0.05)));
      color: var(--accent-primary, var(--primary, #3b82f6));
      border-left: 2px solid var(--accent-primary, var(--primary, #3b82f6));
      font-weight: 500;
    }
  }
}

.audio-body {
  flex: 1;
  padding: 1.5rem;
  overflow: auto;
}

.tab-content {
  h2 {
    font-size: var(--fs-heading-lg, 1.25rem);
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: var(--text-primary, var(--body-text));
  }

  .description {
    font-size: var(--fs-body);
    color: var(--text-muted, var(--muted));
    margin: 0 0 1.5rem;
    line-height: 1.5;

    &.warning {
      color: var(--status-warning, #f59e0b);
    }
  }
}

.setting-section {
  margin-bottom: 2rem;

  h3 {
    font-size: var(--fs-body);
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: var(--text-primary, var(--body-text));
  }
}

.setting-select {
  width: 100%;
  max-width: 400px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  background: var(--bg-page, var(--input-bg));
  color: var(--text-primary, var(--body-text));
  font-size: var(--fs-body);
  outline: none;
  margin-bottom: 0.5rem;

  &:focus {
    border-color: var(--accent-primary, var(--primary, #3b82f6));
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.voice-select-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  max-width: 500px;

  .setting-select {
    flex: 1;
    margin-bottom: 0;
  }
}

.refresh-btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  background: var(--bg-page, var(--input-bg));
  color: var(--text-primary, var(--body-text));
  font-size: var(--fs-body);
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--bg-surface-hover, var(--nav-active));
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.status-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;

  .status-label {
    font-weight: 500;
    font-size: var(--fs-body);
  }
}

.status-badge {
  font-size: var(--fs-body-sm);
  padding: 0.2rem 0.6rem;
  border-radius: 12px;
  font-weight: 500;
}

.badge-success {
  background: var(--bg-success, rgba(34, 197, 94, 0.1));
  color: var(--status-success, #22c55e);
}

.badge-warning {
  background: var(--bg-warning, rgba(245, 158, 11, 0.1));
  color: var(--status-warning, #f59e0b);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.summary-item {
  padding: 1rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  background: var(--bg-surface, var(--card-bg, transparent));

  .summary-label {
    display: block;
    font-size: var(--fs-body-sm);
    color: var(--text-muted, var(--muted));
    margin-bottom: 0.25rem;
  }

  .summary-value {
    display: block;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-primary, var(--body-text));
  }
}
</style>
