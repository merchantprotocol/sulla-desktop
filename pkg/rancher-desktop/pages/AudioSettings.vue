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
              Configure your Enterprise Gateway in Integrations to enable gateway transcription.
            </p>
          </div>

          <!-- Audio Capture (audio-driver) -->
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
              System audio capture uses a virtual loopback driver to record speaker output
              alongside microphone input. Activate via the tray panel Audio tab or Secretary Mode.
            </p>
          </div>

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
                class="refresh-btn"
                :disabled="loadingDevices"
                @click="fetchAudioDevices"
              >
                {{ loadingDevices ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
          </div>

          <!-- Current Settings Summary -->
          <div class="setting-section">
            <h3>Active Configuration</h3>
            <div class="summary-grid">
              <div class="summary-item">
                <span class="summary-label">Transcription Mode</span>
                <span class="summary-value">{{ transcriptionModeLabel }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">TTS Voice</span>
                <span class="summary-value">{{ ttsVoiceName || 'Not selected' }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">Secretary Mode</span>
                <span class="summary-value">{{ secretaryEnabled ? (secretaryAgentName || 'Enabled') : 'Off' }}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">System Audio</span>
                <span class="summary-value">{{ secretaryEnabled && transcriptionMode === 'gateway' ? 'Multi-channel (auto)' : 'Single channel' }}</span>
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
            <h3>Mode</h3>
            <select
              v-model="transcriptionMode"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="browser">Browser (real-time)</option>
              <option
                v-if="apiKeyConnected"
                value="elevenlabs"
              >ElevenLabs (high accuracy)</option>
              <option
                v-if="gatewayConnected"
                value="gateway"
              >Enterprise Gateway</option>
            </select>
            <p class="description">
              <strong>Browser</strong> uses Chrome's built-in speech recognition for instant, live transcription
              that shows your words as you speak. Free, no API key needed.<br>
              <strong>ElevenLabs</strong> uses the Scribe model for higher accuracy transcription,
              but text only appears after you finish speaking.<br>
              <strong>Enterprise Gateway</strong> routes audio through your Enterprise Gateway server,
              which handles transcription server-side. Configure the gateway URL and API key in
              Integrations &rarr; Enterprise Sulla.
            </p>
          </div>

          <div
            v-if="transcriptionMode !== 'gateway'"
            class="setting-section"
          >
            <h3>Model</h3>
            <select
              v-model="transcriptionModel"
              class="setting-select"
              @change="saveSettings"
            >
              <option value="scribe_v2">Scribe v2 (recommended)</option>
              <option value="scribe_v1">Scribe v1</option>
              <option value="scribe_v1_experimental">Scribe v1 Experimental</option>
            </select>
            <p class="description">
              <strong>Scribe v2</strong> is the latest ElevenLabs model with improved accuracy and noise labeling.<br>
              <strong>Scribe v1</strong> is the original production model with broad language support.
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

          <!-- Voice Preview -->
          <div class="setting-section">
            <h3>Preview</h3>
            <button
              class="refresh-btn"
              :disabled="previewPlaying || !ttsVoice"
              @click="previewVoice"
            >
              {{ previewPlaying ? 'Playing...' : 'Test Voice' }}
            </button>
            <p class="description">
              Plays a short sample with the selected voice.
            </p>
          </div>
        </div>

        <!-- Secretary Mode Tab -->
        <div
          v-if="currentNav === 'secretary'"
          class="tab-content"
        >
          <h2>Secretary Mode</h2>
          <p class="description">
            When enabled, your transcribed audio is also forwarded to an ElevenLabs conversational agent.
            You still receive the transcription as normal.
          </p>

          <div
            v-if="!apiKeyConnected"
            class="setting-section"
          >
            <p class="description warning">
              Configure your ElevenLabs API key in Integrations to use Secretary Mode.
            </p>
          </div>

          <template v-else>
            <div class="setting-section">
              <h3>Enable Secretary Mode</h3>
              <label class="toggle-row">
                <input
                  v-model="secretaryEnabled"
                  type="checkbox"
                  class="setting-checkbox"
                  @change="saveSettings"
                >
                <span>Forward transcriptions to an ElevenLabs agent</span>
              </label>
            </div>

            <div class="setting-section">
              <h3>ElevenLabs Agent</h3>
              <div class="voice-select-row">
                <select
                  v-model="secretaryAgentId"
                  class="setting-select"
                  :disabled="loadingAgents || !secretaryEnabled"
                  @change="onAgentChange"
                >
                  <option value="">
                    Select an agent...
                  </option>
                  <option
                    v-for="agent in elevenLabsAgents"
                    :key="agent.value"
                    :value="agent.value"
                  >
                    {{ agent.label }}
                  </option>
                </select>
                <button
                  class="refresh-btn"
                  :disabled="loadingAgents"
                  @click="fetchElevenLabsAgents"
                >
                  {{ loadingAgents ? 'Loading...' : 'Refresh' }}
                </button>
              </div>
              <p
                v-if="secretaryAgentName && secretaryEnabled"
                class="description"
              >
                Active agent: <strong>{{ secretaryAgentName }}</strong>
              </p>
            </div>
          </template>
        </div>

        <!-- Sensitivity Tab -->
        <div
          v-if="currentNav === 'sensitivity'"
          class="tab-content"
        >
          <h2>Voice Sensitivity</h2>
          <p class="description">
            Tune how quickly voice input detects silence and submits your speech.
          </p>

          <div class="setting-section">
            <h3>Silence Duration: {{ vadSilenceDuration }}ms</h3>
            <input
              v-model.number="vadSilenceDuration"
              type="range"
              min="300"
              max="3000"
              step="100"
              class="setting-range"
              @change="saveSettings"
            >
            <p class="description">
              How long you must pause before speech is submitted. Lower = faster response, higher = more time to pause between thoughts.
            </p>
          </div>

          <div class="setting-section">
            <h3>Silence Threshold: {{ vadSilenceThreshold }}</h3>
            <input
              v-model.number="vadSilenceThreshold"
              type="range"
              min="3"
              max="30"
              step="1"
              class="setting-range"
              @change="saveSettings"
            >
            <p class="description">
              Audio level below which counts as silence. Lower = more sensitive (picks up quiet speech), higher = needs louder voice.
            </p>
          </div>

          <div class="setting-section">
            <h3>STT Language</h3>
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
              Language for browser transcription mode. ElevenLabs auto-detects language.
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

// Initialize theme
useTheme();

const navItems = [
  { id: 'overview', name: 'Overview' },
  { id: 'transcription', name: 'Transcription' },
  { id: 'voice', name: 'Voice' },
  { id: 'secretary', name: 'Secretary Mode' },
  { id: 'sensitivity', name: 'Sensitivity' },
];

const currentNav = ref('overview');

// Settings state
const apiKeyConnected = ref(false);
const gatewayConnected = ref(false);
const audioCaptureActive = ref(false);

// Listen for audio-driver state updates
ipcRenderer.on('audio-driver:state', (_event: any, state: { running: boolean }) => {
  audioCaptureActive.value = state.running;
});
const transcriptionMode = ref('browser');
const transcriptionProvider = ref('elevenlabs');
const transcriptionModel = ref('scribe_v2');
const ttsProvider = ref('elevenlabs');
const ttsVoice = ref('');
const ttsVoiceName = ref('');

// VAD sensitivity
const vadSilenceThreshold = ref(12);
const vadSilenceDuration = ref(800);

// Voice preview
const previewPlaying = ref(false);

// Audio devices
const audioInputDeviceId = ref('');
const audioInputDevices = ref<{ value: string; label: string }[]>([]);
const loadingDevices = ref(false);

// STT language
const sttLanguage = ref('en-US');

// Voices
const voices = ref<{ value: string; label: string; description?: string }[]>([]);
const loadingVoices = ref(false);

// Secretary Mode
const secretaryEnabled = ref(false);
const secretaryAgentId = ref('');
const secretaryAgentName = ref('');
const elevenLabsAgents = ref<{ value: string; label: string }[]>([]);
const loadingAgents = ref(false);

const transcriptionModeLabel = computed(() => {
  switch (transcriptionMode.value) {
    case 'browser': return 'Browser (real-time)';
    case 'gateway': return 'Enterprise Gateway';
    default: return 'ElevenLabs';
  }
});

async function loadSettings(): Promise<void> {
  try {
    transcriptionMode.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionMode', 'browser');
    transcriptionProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionProvider', 'elevenlabs');
    transcriptionModel.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionModel', 'scribe_v2');
    ttsProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsProvider', 'elevenlabs');
    ttsVoice.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoice', '');
    ttsVoiceName.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoiceName', '');
    vadSilenceThreshold.value = await ipcRenderer.invoke('sulla-settings-get', 'audioVadSilenceThreshold', 12);
    vadSilenceDuration.value = await ipcRenderer.invoke('sulla-settings-get', 'audioVadSilenceDuration', 800);
    sttLanguage.value = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
    audioInputDeviceId.value = await ipcRenderer.invoke('sulla-settings-get', 'audioInputDeviceId', '');
    secretaryEnabled.value = await ipcRenderer.invoke('sulla-settings-get', 'secretaryEnabled', false);
    secretaryAgentId.value = await ipcRenderer.invoke('sulla-settings-get', 'secretaryAgentId', '');
    secretaryAgentName.value = await ipcRenderer.invoke('sulla-settings-get', 'secretaryAgentName', '');
  } catch (err) {
    console.error('[AudioSettings] Failed to load settings:', err);
  }
}

async function saveSettings(): Promise<void> {
  try {
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionMode', transcriptionMode.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionProvider', transcriptionProvider.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionModel', transcriptionModel.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsProvider', ttsProvider.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoice', ttsVoice.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioVadSilenceThreshold', vadSilenceThreshold.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioVadSilenceDuration', vadSilenceDuration.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioSttLanguage', sttLanguage.value);
    await ipcRenderer.invoke('sulla-settings-set', 'audioInputDeviceId', audioInputDeviceId.value);
    await ipcRenderer.invoke('sulla-settings-set', 'secretaryEnabled', secretaryEnabled.value);
    await ipcRenderer.invoke('sulla-settings-set', 'secretaryAgentId', secretaryAgentId.value);
    await ipcRenderer.invoke('sulla-settings-set', 'secretaryAgentName', secretaryAgentName.value);
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

async function fetchAudioDevices(): Promise<void> {
  if (loadingDevices.value) return;
  loadingDevices.value = true;
  try {
    // Must request mic permission first to get device labels
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

async function fetchElevenLabsAgents(): Promise<void> {
  if (loadingAgents.value) return;
  loadingAgents.value = true;

  try {
    const result = await ipcRenderer.invoke('integration-get-value', 'elevenlabs', 'api_key');
    const apiKey = result?.value;

    if (!apiKey) {
      elevenLabsAgents.value = [];
      return;
    }

    const response = await fetch('https://api.elevenlabs.io/v1/convai/agents', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) {
      console.warn('[AudioSettings] Failed to fetch ElevenLabs agents:', response.status);
      elevenLabsAgents.value = [];
      return;
    }

    const body = await response.json() as { agents?: { agent_id: string; name: string }[] };

    if (body.agents && body.agents.length > 0) {
      elevenLabsAgents.value = body.agents.map(a => ({
        value: a.agent_id,
        label: a.name,
      }));
    } else {
      elevenLabsAgents.value = [];
    }
  } catch (err) {
    console.warn('[AudioSettings] Error fetching ElevenLabs agents:', err);
    elevenLabsAgents.value = [];
  } finally {
    loadingAgents.value = false;
  }
}

function onAgentChange(): void {
  const selected = elevenLabsAgents.value.find(a => a.value === secretaryAgentId.value);
  secretaryAgentName.value = selected?.label || '';
  saveSettings();
}

function getStaticVoices(): { value: string; label: string; description?: string }[] {
  // Only include voices with verified ElevenLabs IDs.
  // Full list loads dynamically from the API when an API key is configured.
  return [
    { value: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica', description: 'premade, default' },
  ];
}

onMounted(async() => {
  await loadSettings();
  await checkApiKey();
  await checkGateway();
  await fetchVoices();
  await fetchAudioDevices();
  await fetchElevenLabsAgents();
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

.setting-range {
  width: 100%;
  max-width: 400px;
  margin-bottom: 0.5rem;
  accent-color: var(--accent-primary, var(--primary, #3b82f6));
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

.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: var(--fs-body);
  color: var(--text-primary, var(--body-text));
}

.setting-checkbox {
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent-primary, var(--primary, #3b82f6));
  cursor: pointer;
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
