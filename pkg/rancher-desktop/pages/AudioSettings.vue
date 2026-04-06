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

        <!-- ═══════════════════════════════════════════════════════════
             Text-to-Speech Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'tts'"
          class="tab-content"
        >
          <h2>Text-to-Speech</h2>
          <p class="description">
            Configure how Sulla speaks responses aloud. When a TTS provider is
            connected and a voice is selected, voice chat becomes two-way &mdash;
            you speak, Sulla speaks back. Without TTS, voice input still works
            but Sulla replies with text only.
          </p>

          <!-- Two-way voice status banner -->
          <div
            class="status-banner"
            :class="ttsFullyConfigured ? 'banner-success' : 'banner-info'"
          >
            <span v-if="ttsFullyConfigured">Two-way voice is enabled. Sulla will speak responses using {{ ttsVoiceName || 'the selected voice' }}.</span>
            <span v-else-if="!hasAnyTtsProvider">No TTS provider connected. Add an API key for a provider below to enable Sulla's voice.</span>
            <span v-else-if="!ttsVoice">Select a voice below to enable two-way voice.</span>
          </div>

          <!-- Provider selection -->
          <div class="setting-section">
            <h3>Provider</h3>
            <div
              v-for="provider in ttsProviders"
              :key="provider.id"
              class="provider-card"
              :class="{
                'provider-active': ttsProvider === provider.id && provider.connected,
                'provider-connected': provider.connected,
                'provider-disconnected': !provider.connected,
              }"
              @click="provider.connected && selectTtsProvider(provider.id)"
            >
              <div class="provider-info">
                <span class="provider-name">{{ provider.name }}</span>
                <span
                  class="status-badge"
                  :class="provider.connected ? 'badge-success' : 'badge-warning'"
                >
                  {{ provider.connected ? 'Connected' : 'Not configured' }}
                </span>
              </div>
              <p
                v-if="!provider.connected"
                class="provider-hint"
              >
                Add your {{ provider.name }} API key in the password vault to enable this provider.
              </p>
              <div
                v-if="provider.connected && ttsProvider === provider.id"
                class="provider-selected-badge"
              >
                Active
              </div>
            </div>
          </div>

          <!-- Voice selection (only when provider is connected) -->
          <div
            v-if="hasAnyTtsProvider"
            class="setting-section"
          >
            <h3>Voice</h3>
            <div class="voice-select-row">
              <select
                v-model="ttsVoice"
                class="setting-select"
                :disabled="loadingVoices"
                @change="onVoiceChange"
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
                class="action-btn"
                :disabled="loadingVoices"
                @click="fetchVoices"
              >
                {{ loadingVoices ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
          </div>

          <!-- Voice preview -->
          <div
            v-if="ttsVoice"
            class="setting-section"
          >
            <h3>Preview</h3>
            <button
              class="action-btn"
              :disabled="previewPlaying"
              @click="previewVoice"
            >
              {{ previewPlaying ? 'Playing...' : 'Test Voice' }}
            </button>
            <p class="description">
              Plays a short sample with the selected voice.
            </p>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════════════
             Secretary Mode Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'secretary'"
          class="tab-content"
        >
          <h2>Secretary Mode</h2>
          <p class="description">
            Secretary mode uses the audio driver to capture both your microphone
            and system audio (speaker output) for meeting transcription.
            This is the only mode that requires the audio driver.
          </p>

          <!-- Audio Capture Status -->
          <div class="setting-section">
            <h3>Audio Capture</h3>
            <div class="status-row">
              <span class="status-label">Loopback Driver:</span>
              <span
                class="status-badge"
                :class="audioCaptureActive ? 'badge-success' : 'badge-warning'"
              >
                {{ audioCaptureActive ? 'Active' : 'Inactive' }}
              </span>
            </div>
            <p class="description">
              System audio capture uses a virtual loopback driver to record
              speaker output alongside microphone input. Activate via the tray
              panel or by starting a Secretary Mode session.
            </p>
          </div>

          <!-- Transcription Mode (secretary only) -->
          <div class="setting-section">
            <h3>Transcription Mode</h3>
            <select
              v-model="transcriptionMode"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="browser">Browser (real-time)</option>
              <option
                v-if="gatewayConnected"
                value="gateway"
              >Enterprise Gateway</option>
            </select>
            <p class="description">
              <strong>Browser</strong> uses built-in speech recognition for mic
              transcription. Free, no API key needed.<br>
              <strong>Enterprise Gateway</strong> routes both mic and speaker
              audio through your gateway server for multi-channel transcription.
            </p>
          </div>

          <!-- Gateway connection -->
          <div class="setting-section">
            <h3>Enterprise Gateway</h3>
            <div class="status-row">
              <span class="status-label">Connection:</span>
              <span
                class="status-badge"
                :class="gatewayConnected ? 'badge-success' : 'badge-warning'"
              >
                {{ gatewayConnected ? 'Connected' : 'Not configured' }}
              </span>
            </div>
            <p
              v-if="!gatewayConnected"
              class="description"
            >
              Configure the Enterprise Gateway URL and API key in the password vault
              to enable gateway transcription.
            </p>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════════════
             Microphone & Language Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'microphone'"
          class="tab-content"
        >
          <h2>Microphone &amp; Language</h2>
          <p class="description">
            These settings apply to all voice features: chat, teleprompter,
            capture studio, and secretary mode.
          </p>

          <!-- Audio Input Device -->
          <div class="setting-section">
            <h3>Microphone</h3>
            <div class="voice-select-row">
              <select
                v-model="audioInputDeviceId"
                class="setting-select"
                :disabled="loadingDevices"
                @change="saveSettings"
              >
                <option value="">
                  System Default
                </option>
                <option
                  v-for="device in audioInputDevices"
                  :key="device.value"
                  :value="device.value"
                >
                  {{ device.label }}
                </option>
              </select>
              <button
                class="action-btn"
                :disabled="loadingDevices"
                @click="fetchAudioDevices"
              >
                {{ loadingDevices ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
          </div>

          <!-- STT Language -->
          <div class="setting-section">
            <h3>Speech Recognition Language</h3>
            <select
              v-model="sttLanguage"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
              <option value="es-ES">Spanish</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="it-IT">Italian</option>
              <option value="pt-BR">Portuguese (Brazil)</option>
              <option value="ja-JP">Japanese</option>
              <option value="ko-KR">Korean</option>
              <option value="zh-CN">Chinese (Simplified)</option>
            </select>
            <p class="description">
              Language used by browser speech recognition for chat and
              teleprompter voice input.
            </p>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useTheme } from '../composables/useTheme';

useTheme();

// ─── Navigation ─────────────────────────────────────────────────

const navItems = [
  { id: 'tts', name: 'Text-to-Speech' },
  { id: 'secretary', name: 'Secretary Mode' },
  { id: 'microphone', name: 'Microphone & Language' },
];

const currentNav = ref('tts');

// ─── TTS Providers ──────────────────────────────────────────────

interface TtsProviderInfo {
  id:        string;
  name:      string;
  connected: boolean;
  vaultKey:  { integrationId: string; property: string };
}

const ttsProviders = ref<TtsProviderInfo[]>([
  { id: 'elevenlabs', name: 'ElevenLabs', connected: false, vaultKey: { integrationId: 'elevenlabs', property: 'api_key' } },
]);

const ttsProvider = ref('elevenlabs');
const ttsVoice = ref('');
const ttsVoiceName = ref('');
const voices = ref<{ value: string; label: string; description?: string }[]>([]);
const loadingVoices = ref(false);
const previewPlaying = ref(false);

const hasAnyTtsProvider = computed(() => ttsProviders.value.some(p => p.connected));
const ttsFullyConfigured = computed(() => hasAnyTtsProvider.value && !!ttsVoice.value);

function selectTtsProvider(id: string) {
  ttsProvider.value = id;
  ttsVoice.value = '';
  ttsVoiceName.value = '';
  saveSettings();
  fetchVoices();
}

function onVoiceChange() {
  const selected = voices.value.find(v => v.value === ttsVoice.value);
  ttsVoiceName.value = selected?.label || '';
  saveSettings();
}

// ─── Secretary Mode ─────────────────────────────────────────────

const audioCaptureActive = ref(false);
const gatewayConnected = ref(false);
const transcriptionMode = ref('browser');

ipcRenderer.on('audio-driver:state', (_event: any, state: { running: boolean }) => {
  audioCaptureActive.value = state.running;
});

// ─── Microphone & Language ──────────────────────────────────────

const audioInputDeviceId = ref('');
const audioInputDevices = ref<{ value: string; label: string }[]>([]);
const loadingDevices = ref(false);
const sttLanguage = ref('en-US');

// ─── Settings persistence ───────────────────────────────────────

async function loadSettings(): Promise<void> {
  try {
    ttsProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsProvider', 'elevenlabs');
    ttsVoice.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoice', '');
    ttsVoiceName.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoiceName', '');
    transcriptionMode.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionMode', 'browser');
    sttLanguage.value = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
    audioInputDeviceId.value = await ipcRenderer.invoke('sulla-settings-get', 'audioInputDeviceId', '');
  } catch (err) {
    console.error('[AudioSettings] Failed to load settings:', err);
  }
}

async function saveSettings(): Promise<void> {
  try {
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsProvider', ttsProvider.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoice', ttsVoice.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoiceName', ttsVoiceName.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionMode', transcriptionMode.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioSttLanguage', sttLanguage.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioInputDeviceId', audioInputDeviceId.value);
  } catch (err) {
    console.error('[AudioSettings] Failed to save settings:', err);
  }
}

// ─── Provider connection checks ─────────────────────────────────

async function checkProviders(): Promise<void> {
  for (const provider of ttsProviders.value) {
    try {
      const result = await ipcRenderer.invoke(
        'integration-get-value',
        provider.vaultKey.integrationId,
        provider.vaultKey.property,
      );
      provider.connected = !!(result?.value);
    } catch {
      provider.connected = false;
    }
  }
}

async function checkGateway(): Promise<void> {
  try {
    const [urlResult, keyResult] = await Promise.all([
      ipcRenderer.invoke('integration-get-value', 'enterprise_gateway', 'gateway_url'),
      ipcRenderer.invoke('integration-get-value', 'enterprise_gateway', 'api_key'),
    ]);
    gatewayConnected.value = !!(urlResult?.value && keyResult?.value);
  } catch {
    gatewayConnected.value = false;
  }
}

// ─── Voice fetching ─────────────────────────────────────────────

async function fetchVoices(): Promise<void> {
  if (loadingVoices.value) return;
  loadingVoices.value = true;

  try {
    if (ttsProvider.value === 'elevenlabs') {
      await fetchElevenLabsVoices();
    }
  } finally {
    loadingVoices.value = false;
  }
}

async function fetchElevenLabsVoices(): Promise<void> {
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
  }
}

function getStaticVoices(): { value: string; label: string; description?: string }[] {
  return [
    { value: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica', description: 'premade, default' },
  ];
}

// ─── Device enumeration ─────────────────────────────────────────

async function fetchAudioDevices(): Promise<void> {
  if (loadingDevices.value) return;
  loadingDevices.value = true;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hiddenDevices = ['blackhole', 'sulla audio mirror'];
    audioInputDevices.value = devices
      .filter(d => d.kind === 'audioinput')
      .filter(d => !hiddenDevices.some(h => (d.label || '').toLowerCase().includes(h)))
      .map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Microphone ${ i + 1 }`,
      }));
  } catch (err) {
    console.warn('[AudioSettings] Failed to enumerate audio devices:', err);
    audioInputDevices.value = [];
  } finally {
    loadingDevices.value = false;
  }
}

// ─── Voice preview ──────────────────────────────────────────────

async function previewVoice(): Promise<void> {
  if (previewPlaying.value) return;
  previewPlaying.value = true;
  try {
    const result = await ipcRenderer.invoke('audio-speak', { text: 'Hello, this is how I sound.' });
    if (result?.audio) {
      const blob = new Blob([result.audio], { type: result.mimeType || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        audio.play().catch(() => resolve());
      });
    }
  } catch (err) {
    console.warn('[AudioSettings] Voice preview failed:', err);
  } finally {
    previewPlaying.value = false;
  }
}

// ─── Init ───────────────────────────────────────────────────────

onMounted(async() => {
  await loadSettings();
  await checkProviders();
  await checkGateway();
  await fetchVoices();
  await fetchAudioDevices();
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

.action-btn {
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

// ── Status banner ──

.status-banner {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: var(--fs-body);
  margin-bottom: 1.5rem;
  line-height: 1.5;
}

.banner-success {
  background: var(--bg-success, rgba(34, 197, 94, 0.1));
  color: var(--status-success, #22c55e);
  border: 1px solid var(--status-success, #22c55e);
}

.banner-info {
  background: var(--bg-warning, rgba(245, 158, 11, 0.08));
  color: var(--text-muted, var(--muted));
  border: 1px solid var(--border-default, var(--input-border));
}

// ── Provider cards ──

.provider-card {
  position: relative;
  padding: 1rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  margin-bottom: 0.75rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;

  &.provider-connected:hover {
    border-color: var(--accent-primary, var(--primary, #3b82f6));
    background: var(--bg-surface-hover, rgba(59, 130, 246, 0.03));
  }

  &.provider-active {
    border-color: var(--accent-primary, var(--primary, #3b82f6));
    background: var(--bg-active, var(--primary-light-bg, rgba(59, 130, 246, 0.05)));
  }

  &.provider-disconnected {
    cursor: default;
    opacity: 0.7;
  }
}

.provider-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.provider-name {
  font-weight: 600;
  font-size: var(--fs-body);
}

.provider-hint {
  margin: 0.5rem 0 0;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
}

.provider-selected-badge {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  font-size: var(--fs-body-sm);
  padding: 0.15rem 0.5rem;
  border-radius: 12px;
  background: var(--accent-primary, var(--primary, #3b82f6));
  color: #fff;
  font-weight: 500;
}
</style>
