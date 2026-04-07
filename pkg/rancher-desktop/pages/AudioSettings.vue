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
             Speaker Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'speaker'"
          class="tab-content"
        >
          <h2>Speaker</h2>
          <p class="description">
            Monitor and control your system speaker output. The audio driver
            captures speaker audio via a virtual loopback device for meeting
            transcription and audio monitoring.
          </p>

          <!-- Audio Driver Activate -->
          <div class="setting-section">
            <h3>Audio Driver</h3>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': driverRunning }"
                @click="toggleAudioDriver"
              >
                {{ driverRunning ? 'Stop Audio Driver' : 'Activate Audio Driver' }}
              </button>
            </div>
            <div class="status-row">
              <span class="status-label">Status:</span>
              <span
                class="status-badge"
                :class="driverRunning ? 'badge-success' : 'badge-warning'"
              >
                {{ driverRunning ? 'Running' : 'Stopped' }}
              </span>
            </div>
            <p
              v-if="!driverRunning"
              class="description"
            >
              Activate the audio driver to enable speaker monitoring, volume
              controls, and system audio capture for transcription.
            </p>
          </div>

          <!-- Output Device Selector -->
          <div class="setting-section">
            <h3>Output Device</h3>
            <div class="voice-select-row">
              <select
                v-model="speakerDeviceId"
                class="setting-select"
                :disabled="loadingSpeakerDevices"
                @change="onSpeakerDeviceChange"
              >
                <option value="">
                  System Default
                </option>
                <option
                  v-for="device in speakerOutputDevices"
                  :key="device.value"
                  :value="device.value"
                >
                  {{ device.label }}
                </option>
              </select>
              <button
                class="action-btn"
                :disabled="loadingSpeakerDevices"
                @click="fetchSpeakerDevices"
              >
                {{ loadingSpeakerDevices ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
            <p class="description">
              Select which speaker device is used as the default system output.
            </p>
          </div>

          <!-- Speaker Level Meter -->
          <div class="setting-section">
            <h3>Speaker Level</h3>
            <div class="speaker-meter-container">
              <div class="speaker-meter-track">
                <div
                  class="speaker-meter-fill"
                  :class="{
                    'meter-green': speakerMeterPct < 50,
                    'meter-yellow': speakerMeterPct >= 50 && speakerMeterPct < 80,
                    'meter-red': speakerMeterPct >= 80,
                  }"
                  :style="{ width: speakerMeterPct + '%' }"
                />
                <div
                  class="speaker-meter-peak-indicator"
                  :style="{ left: speakerPeakPct + '%', opacity: speakerPeakPct > 1 ? 0.8 : 0 }"
                />
              </div>
              <span class="speaker-meter-db">{{ speakerMeterDbDisplay }} dB</span>
            </div>
            <p
              v-if="!driverRunning"
              class="description"
            >
              Start the audio driver to see the real-time speaker level meter.
            </p>
          </div>

          <!-- Volume Controls -->
          <div class="setting-section">
            <h3>Volume</h3>
            <div class="speaker-volume-controls">
              <button
                class="icon-btn-lg"
                :class="{ 'icon-btn-muted': speakerMuted }"
                title="Toggle Mute"
                @click="onSpeakerMuteToggle"
              >
                <svg
                  v-if="speakerMuted"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </svg>
                <svg
                  v-else
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
                  <path d="M16 9a5 5 0 0 1 0 6" />
                  <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
                </svg>
              </button>

              <button
                class="icon-btn-lg"
                title="Volume Down"
                @click="onSpeakerVolumeDown"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
                </svg>
              </button>

              <span class="speaker-volume-label">{{ speakerVolumeDisplay }}</span>

              <button
                class="icon-btn-lg"
                title="Volume Up"
                @click="onSpeakerVolumeUp"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
                  <path d="M16 9a5 5 0 0 1 0 6" />
                  <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
                </svg>
              </button>
            </div>
          </div>
        </div>

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
                @change="onMicDeviceChange"
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

          <!-- ── Audio Driver Pipeline ── -->
          <div class="setting-section">
            <h3>Audio Driver</h3>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': driverRunning }"
                @click="toggleAudioDriver"
              >
                {{ driverRunning ? 'Stop Audio Driver' : 'Start Audio Driver' }}
              </button>
            </div>

            <!-- Pipeline meters (visible when driver is running) -->
            <div
              v-if="driverRunning"
              class="pipeline-section"
            >
              <!-- VAD Speaking indicator -->
              <div class="pipeline-row">
                <span class="pipeline-label">VAD</span>
                <div
                  class="vad-indicator"
                  :class="vadSpeaking ? 'vad-speaking' : 'vad-silent'"
                >
                  {{ vadSpeaking ? 'SPEAKING' : 'SILENT' }}
                </div>
                <div
                  v-if="vadFanNoise"
                  class="vad-indicator vad-fan"
                >
                  FAN NOISE
                </div>
              </div>

              <!-- Mic level meter (from audio-driver VAD) -->
              <div class="pipeline-row">
                <span class="pipeline-label">Mic Level</span>
                <div class="mic-meter-track">
                  <div
                    class="mic-meter-fill"
                    :class="{
                      'meter-green': driverMicLevel < 0.5,
                      'meter-yellow': driverMicLevel >= 0.5 && driverMicLevel < 0.8,
                      'meter-red': driverMicLevel >= 0.8,
                    }"
                    :style="{ width: (driverMicLevel * 100) + '%' }"
                  />
                </div>
                <span class="pipeline-value">{{ driverMicDb }} dB</span>
              </div>

              <!-- Noise floor -->
              <div class="pipeline-row">
                <span class="pipeline-label">Noise Floor</span>
                <div class="mic-meter-track">
                  <div
                    class="mic-meter-fill meter-blue"
                    :style="{ width: Math.min(100, vadNoiseFloor * 1000) + '%' }"
                  />
                </div>
                <span class="pipeline-value">{{ vadNoiseFloorDb }} dB</span>
              </div>

              <!-- Speaker level meter -->
              <div class="pipeline-row">
                <span class="pipeline-label">Speaker</span>
                <div class="mic-meter-track">
                  <div
                    class="mic-meter-fill"
                    :class="{
                      'meter-green': driverSpeakerLevel < 0.5,
                      'meter-yellow': driverSpeakerLevel >= 0.5 && driverSpeakerLevel < 0.8,
                      'meter-red': driverSpeakerLevel >= 0.8,
                    }"
                    :style="{ width: (driverSpeakerLevel * 100) + '%' }"
                  />
                </div>
                <span class="pipeline-value">{{ driverSpeakerDb }} dB</span>
              </div>

              <!-- Detail stats -->
              <div class="pipeline-stats">
                <div class="stat-item">
                  <span class="stat-label">ZCR</span>
                  <span class="stat-value">{{ vadZcr }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Variance</span>
                  <span class="stat-value">{{ vadVariance }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Pitch</span>
                  <span class="stat-value">{{ vadPitch }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Centroid</span>
                  <span class="stat-value">{{ vadCentroid }}</span>
                </div>
              </div>
            </div>

            <p
              v-if="!driverRunning"
              class="description"
            >
              Start the audio driver to see the full VAD pipeline: mic level,
              noise floor, speech detection, spectral analysis, and speaker
              capture. This is the same pipeline used by chat voice and
              secretary mode.
            </p>
          </div>

          <!-- ── Test Record & Playback ── -->
          <div class="setting-section">
            <h3>Test Recording</h3>
            <p class="description">
              Record your voice and play it back to test the microphone.
            </p>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{
                  'btn-active-red': testRecording,
                  'btn-active-green': testPlaying,
                }"
                :disabled="!driverRunning"
                @click="toggleTestRecording"
              >
                {{ testRecording ? 'Stop Recording' : testPlaying ? 'Playing...' : 'Record Test' }}
              </button>
              <button
                v-if="testHasRecording && !testRecording && !testPlaying"
                class="action-btn"
                @click="playTestRecording"
              >
                Play Back
              </button>
            </div>
            <p
              v-if="!driverRunning"
              class="description"
            >
              Start the audio driver above to enable test recording. The recording
              captures audio through the driver's full pipeline (gain, filtering, VAD).
            </p>
            <div
              v-if="testRecording || testPlaying"
              class="test-progress-section"
            >
              <div class="mic-meter-track">
                <div
                  class="mic-meter-fill"
                  :class="testRecording ? 'meter-red' : 'meter-green'"
                  :style="{ width: testProgress + '%' }"
                />
              </div>
              <span class="mic-meter-db">{{ testTimerText }}</span>
            </div>
          </div>

          <!-- ── Live Transcript (browser SpeechRecognition driven by audio driver VAD) ── -->
          <div class="setting-section">
            <h3>Live Transcript</h3>
            <p class="description">
              Uses the audio driver's VAD to control browser SpeechRecognition.
              When VAD detects speech, recognition starts. When silence is detected,
              recognition stops and the text is finalized.
            </p>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': transcriptListening }"
                :disabled="!driverRunning"
                @click="toggleTranscriptListening"
              >
                {{ transcriptListening ? 'Stop Listening' : 'Start Listening' }}
              </button>
            </div>
            <p
              v-if="!driverRunning"
              class="description"
            >
              Start the audio driver above to enable live transcription.
            </p>
            <div
              ref="transcriptAreaRef"
              class="transcript-area"
            >
              <div
                v-if="!transcriptEntries || transcriptEntries.length === 0"
                class="transcript-empty"
              >
                Transcripts will appear here during active sessions...
              </div>
              <div
                v-for="(entry, i) in transcriptEntries"
                :key="i"
                class="transcript-entry"
                :class="{ 'transcript-partial': entry.partial }"
              >
                <span class="transcript-speaker">{{ entry.speaker }}</span>
                <span class="transcript-text">{{ entry.text }}</span>
              </div>
            </div>
          </div>

          <!-- ── Raw Mic Test (no audio-driver dependency) ── -->
          <div class="setting-section">
            <h3>Raw Mic Test</h3>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                @click="toggleMicTest"
              >
                {{ micTesting ? 'Stop Test' : 'Start Test' }}
              </button>
              <button
                v-if="micTesting"
                class="action-btn"
                :class="{ 'btn-active': micMuted }"
                @click="toggleMicMute"
              >
                {{ micMuted ? 'Unmute' : 'Mute' }}
              </button>
            </div>

            <div
              v-if="micTesting"
              class="mic-meter-section"
            >
              <div class="mic-meter-row">
                <span class="mic-meter-label">Level</span>
                <div class="mic-meter-track">
                  <div
                    class="mic-meter-fill"
                    :class="{
                      'meter-green': micLevel < 0.5,
                      'meter-yellow': micLevel >= 0.5 && micLevel < 0.8,
                      'meter-red': micLevel >= 0.8,
                    }"
                    :style="{ width: (micLevel * 100) + '%' }"
                  />
                </div>
                <span class="mic-meter-db">{{ micDb }} dB</span>
              </div>

              <div class="mic-meter-row">
                <span class="mic-meter-label">Gain</span>
                <input
                  v-model.number="micGain"
                  type="range"
                  min="0"
                  max="200"
                  step="5"
                  class="mic-gain-slider"
                  @input="onMicGainChange"
                >
                <span class="mic-meter-db">{{ micGain }}%</span>
              </div>
            </div>

            <p class="description">
              Direct mic test via getUserMedia. No audio driver needed.
              Use this to verify the mic hardware works independently.
            </p>
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
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useTheme } from '../composables/useTheme';

// The audio-driver IPC channels are not yet in the typed IpcRendererEvents
// interface. Use an untyped reference for audio-driver-specific calls.
const ipc = ipcRenderer as any;

useTheme();

// ─── Navigation ─────────────────────────────────────────────────

const navItems = [
  { id: 'speaker', name: 'Speaker' },
  { id: 'tts', name: 'Text-to-Speech' },
  { id: 'secretary', name: 'Secretary Mode' },
  { id: 'microphone', name: 'Microphone & Language' },
];

const currentNav = ref('speaker');

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

ipc.on('audio-driver:state', (_event: any, state: { running: boolean }) => {
  if (!state) return;
  audioCaptureActive.value = state.running;
});

// ─── Microphone & Language ──────────────────────────────────────

const audioInputDeviceId = ref('');
const audioInputDevices = ref<{ value: string; label: string }[]>([]);
const loadingDevices = ref(false);
const sttLanguage = ref('en-US');

// ─── Speaker tab ────────────────────────────────────────────────

const speakerDeviceId = ref('');
const speakerOutputDevices = ref<{ value: string; label: string }[]>([]);
const loadingSpeakerDevices = ref(false);
const speakerVolume = ref(1);   // 0.0–1.0
const speakerMuted = ref(false);
const speakerRms = ref(0);
const speakerPeakVal = ref(0);  // peak hold with decay
const PEAK_DECAY = 0.02;

const speakerMeterPct = computed(() => Math.min(100, Math.pow(speakerRms.value, 0.5) * 100));
const speakerPeakPct = computed(() => speakerPeakVal.value);
const speakerMeterDbDisplay = computed(() => {
  if (speakerRms.value <= 0.0001) return '--';
  return (20 * Math.log10(speakerRms.value)).toFixed(0);
});
const speakerVolumeDisplay = computed(() => {
  if (speakerMuted.value) return 'Muted';
  return `${ Math.round(speakerVolume.value * 100) }%`;
});

function onSpeakerLevelForMeter(_event: any, data: { rms: number; peak?: number }) {
  if (!data) return;
  const rms = typeof data === 'number' ? data : data.rms;
  speakerRms.value = rms;

  const pct = Math.min(100, Math.pow(rms, 0.5) * 100);
  if (pct > speakerPeakVal.value) {
    speakerPeakVal.value = pct;
  } else {
    speakerPeakVal.value = Math.max(0, speakerPeakVal.value - PEAK_DECAY * 100);
  }
}

function onVolumeChanged(_event: any, state: { ok: boolean; volume: number; muted: boolean } | undefined) {
  if (!state || !state.ok) return;
  speakerVolume.value = state.volume;
  speakerMuted.value = state.muted;
}

async function onSpeakerMuteToggle() {
  const result = await ipc.invoke('audio-driver:speaker-mute-toggle');
  if (result?.ok) {
    speakerVolume.value = result.volume;
    speakerMuted.value = result.muted;
  }
}

async function onSpeakerVolumeUp() {
  const result = await ipc.invoke('audio-driver:speaker-volume-up');
  if (result?.ok) {
    speakerVolume.value = result.volume;
    speakerMuted.value = result.muted;
  }
}

async function onSpeakerVolumeDown() {
  const result = await ipc.invoke('audio-driver:speaker-volume-down');
  if (result?.ok) {
    speakerVolume.value = result.volume;
    speakerMuted.value = result.muted;
  }
}

async function fetchSpeakerDevices() {
  if (loadingSpeakerDevices.value) return;
  loadingSpeakerDevices.value = true;
  try {
    // Need a temp mic stream to get labels from enumerateDevices
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hiddenDevices = ['blackhole', 'sulla audio mirror', 'audio driver mirror'];
    speakerOutputDevices.value = devices
      .filter(d => d.kind === 'audiooutput')
      .filter(d => d.deviceId && d.deviceId !== 'default')
      .filter(d => !hiddenDevices.some(h => (d.label || '').toLowerCase().includes(h)))
      .map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Speaker ${ i + 1 }`,
      }));
  } catch (err) {
    console.warn('[AudioSettings] Failed to enumerate output devices:', err);
    speakerOutputDevices.value = [];
  } finally {
    loadingSpeakerDevices.value = false;
  }
}

async function onSpeakerDeviceChange() {
  const selected = speakerOutputDevices.value.find(d => d.value === speakerDeviceId.value);
  if (selected) {
    await ipc.invoke('audio-driver:set-system-output', selected.label);
  }
}

async function fetchSpeakerVolume() {
  try {
    const result = await ipc.invoke('audio-driver:speaker-volume-get');
    if (result?.ok) {
      speakerVolume.value = result.volume;
      speakerMuted.value = result.muted;
    }
  } catch { /* ignore */ }
}

ipc.on('audio-driver:speaker-level', onSpeakerLevelForMeter);
ipc.on('audio-driver:volume-changed', onVolumeChanged);

// ─── Audio Driver pipeline ──────────────────────────────────────

const driverRunning = ref(false);
const driverMicLevel = ref(0);
const driverSpeakerLevel = ref(0);
const vadSpeaking = ref(false);
const vadFanNoise = ref(false);
const vadNoiseFloor = ref(0);
const vadZcr = ref('0.000');
const vadVariance = ref('0.000000');
const vadPitch = ref('--');
const vadCentroid = ref('0.0000');

const driverMicDb = computed(() => {
  if (driverMicLevel.value <= 0) return '-inf';
  const db = 20 * Math.log10(driverMicLevel.value);
  return db > -100 ? db.toFixed(0) : '-inf';
});

const driverSpeakerDb = computed(() => {
  if (driverSpeakerLevel.value <= 0) return '-inf';
  const db = 20 * Math.log10(driverSpeakerLevel.value);
  return db > -100 ? db.toFixed(0) : '-inf';
});

const vadNoiseFloorDb = computed(() => {
  if (vadNoiseFloor.value <= 0) return '-inf';
  const db = 20 * Math.log10(vadNoiseFloor.value);
  return db > -100 ? db.toFixed(1) : '-inf';
});

function onMicVad(_event: any, data: { speaking: boolean; level: number; fanNoise: boolean; noiseFloor?: number; zcr?: number; variance?: number; pitch?: number | null; centroid?: number }) {
  if (!data) return;
  driverMicLevel.value = data.level;
  vadSpeaking.value = data.speaking;
  vadFanNoise.value = data.fanNoise;
  if (data.noiseFloor !== undefined) vadNoiseFloor.value = data.noiseFloor;
  if (data.zcr !== undefined) vadZcr.value = data.zcr.toFixed(3);
  if (data.variance !== undefined) vadVariance.value = data.variance.toFixed(6);
  if (data.pitch !== undefined) vadPitch.value = data.pitch !== null ? `${data.pitch.toFixed(0)} Hz` : '--';
  if (data.centroid !== undefined) vadCentroid.value = data.centroid.toFixed(4);
}

function onSpeakerLevel(_event: any, data: { rms: number }) {
  if (!data) return;
  driverSpeakerLevel.value = typeof data === 'number' ? data : data.rms;
}

function onDriverState(_event: any, state: { running: boolean } | undefined) {
  if (!state) return;
  driverRunning.value = state.running;
  if (!state.running) {
    driverMicLevel.value = 0;
    driverSpeakerLevel.value = 0;
    vadSpeaking.value = false;
    vadFanNoise.value = false;
    vadNoiseFloor.value = 0;
  }
}

async function toggleAudioDriver() {
  ipc.send('audio-driver:toggle');
}

// Register driver IPC listeners immediately (settings page should always reflect driver state)
ipc.on('audio-driver:mic-vad', onMicVad);
ipc.on('audio-driver:speaker-level', onSpeakerLevel);
ipc.on('audio-driver:state', onDriverState);

// ─── Test Record & Playback ────────────────────────────────────

const testRecording = ref(false);
const testPlaying = ref(false);
const testHasRecording = ref(false);
const testProgress = ref(0);
const testTimerText = ref('');
const transcriptAreaRef = ref<HTMLElement | null>(null);

let testRecordTimer: ReturnType<typeof setInterval> | null = null;
let testRecordStart = 0;
let testAudioBlob: Blob | null = null;
const TEST_MAX_SECONDS = 10;

function toggleTestRecording() {
  if (testPlaying.value) return;
  if (testRecording.value) {
    stopTestRecording();
  } else {
    startTestRecording();
  }
}

async function startTestRecording() {
  if (!driverRunning.value) {
    console.warn('[AudioSettings] Audio driver must be running to test record');
    return;
  }

  testHasRecording.value = false;
  testAudioBlob = null;
  testProgress.value = 0;
  testTimerText.value = '0s';

  try {
    // Tell the main process to start buffering mic chunks from the audio driver pipeline
    await ipc.invoke('audio-driver:test-record-start');
    testRecording.value = true;
    testRecordStart = Date.now();

    testRecordTimer = setInterval(() => {
      const elapsed = (Date.now() - testRecordStart) / 1000;
      testProgress.value = Math.min(100, (elapsed / TEST_MAX_SECONDS) * 100);
      testTimerText.value = `${ Math.floor(elapsed) }s`;
      if (elapsed >= TEST_MAX_SECONDS) {
        stopTestRecording();
      }
    }, 100);
  } catch (e) {
    console.error('[AudioSettings] Test recording failed:', e);
    testRecording.value = false;
  }
}

async function stopTestRecording() {
  testRecording.value = false;
  if (testRecordTimer) {
    clearInterval(testRecordTimer);
    testRecordTimer = null;
  }

  try {
    // Tell the main process to stop buffering and return the audio data
    const result = await ipc.invoke('audio-driver:test-record-stop');
    if (result?.ok && result.audio && result.audio.byteLength > 0) {
      testAudioBlob = new Blob([result.audio], { type: 'audio/webm' });
      testHasRecording.value = true;
    }
  } catch (e) {
    console.error('[AudioSettings] Failed to stop test recording:', e);
  }
}

async function playTestRecording() {
  if (!testAudioBlob || testPlaying.value) return;

  testPlaying.value = true;
  testProgress.value = 0;
  testTimerText.value = '0s';

  const url = URL.createObjectURL(testAudioBlob);
  const audio = new Audio(url);

  const updatePlayProgress = setInterval(() => {
    if (audio.duration && isFinite(audio.duration)) {
      testProgress.value = (audio.currentTime / audio.duration) * 100;
      testTimerText.value = `${ Math.floor(audio.currentTime) }s`;
    }
  }, 100);

  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });

  clearInterval(updatePlayProgress);
  URL.revokeObjectURL(url);
  testPlaying.value = false;
  testProgress.value = 0;
  testTimerText.value = '';
}

// ─── Live Transcript (Browser SpeechRecognition driven by Audio Driver VAD) ──
//
// This uses the same pattern as useVoiceSession.ts:
//   1. audio-driver:mic-vad events arrive with { speaking, level, fanNoise }
//   2. speaking=true  → start SpeechRecognition
//   3. speaking=false → after silence debounce, stop recognition and finalize
//
// The transcript shows what the browser's built-in speech recognition produces
// when driven by the audio driver's VAD pipeline (noise floor, ZCR, pitch,
// spectral analysis, hysteresis, frame counting). This proves the full pipeline
// end-to-end: audio driver captures mic → VAD detects speech → browser STT
// transcribes → text appears.

interface TranscriptEntry {
  speaker: string;
  text: string;
  partial: boolean;
}

const transcriptEntries = ref<TranscriptEntry[]>([]);
const transcriptListening = ref(false);

const TRANSCRIPT_SILENCE_DELAY = 1500; // ms of silence before finalizing

let sttRecognition: any = null;
let sttRunning = false;
let sttSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let sttInterimText = '';

/**
 * Create a browser SpeechRecognition instance configured for continuous
 * interim results. The VAD controls start/stop — not the recognition itself.
 */
function createSttRecognition(): any {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = sttLanguage.value || 'en-US';

  rec.onresult = (event: any) => {
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        final += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    if (final.trim()) {
      // Final result — add as completed entry
      transcriptEntries.value.push({ speaker: 'You', text: final.trim(), partial: false });
      sttInterimText = '';
    } else if (interim.trim()) {
      // Interim result — update the last partial entry or add new one
      sttInterimText = interim.trim();
      const last = transcriptEntries.value[transcriptEntries.value.length - 1];
      if (last && last.partial) {
        last.text = sttInterimText;
      } else {
        transcriptEntries.value.push({ speaker: 'You', text: sttInterimText, partial: true });
      }
    }

    // Cap entries
    if (transcriptEntries.value.length > 100) {
      transcriptEntries.value.splice(0, transcriptEntries.value.length - 100);
    }

    // Auto-scroll
    nextTick(() => {
      if (transcriptAreaRef.value) {
        transcriptAreaRef.value.scrollTop = transcriptAreaRef.value.scrollHeight;
      }
    });
  };

  rec.onend = () => {
    sttRunning = false;
    // If still listening, VAD will restart it on next speaking event
  };

  rec.onerror = (event: any) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('[AudioSettings] SpeechRecognition error:', event.error);
    sttRunning = false;
  };

  return rec;
}

function startStt() {
  if (sttRunning) return;
  if (!sttRecognition) {
    sttRecognition = createSttRecognition();
    if (!sttRecognition) return;
  }
  try {
    sttRecognition.start();
    sttRunning = true;
  } catch {
    // Already started
  }
}

function stopStt() {
  if (!sttRecognition) return;
  try {
    sttRecognition.stop();
  } catch {
    // Already stopped
  }
  sttRunning = false;
}

/**
 * Handle VAD events from the audio driver for the transcript.
 * When the driver detects speech, start browser SpeechRecognition.
 * When silence is detected, debounce and finalize.
 */
function onTranscriptVad(_event: any, data: { speaking: boolean } | undefined) {
  if (!data || !transcriptListening.value) return;

  if (data.speaking) {
    // Clear any pending silence timer
    if (sttSilenceTimer) {
      clearTimeout(sttSilenceTimer);
      sttSilenceTimer = null;
    }
    startStt();
  } else {
    // Silence — debounce before stopping recognition
    if (sttRunning && !sttSilenceTimer) {
      sttSilenceTimer = setTimeout(() => {
        sttSilenceTimer = null;
        stopStt();
        // Finalize any remaining interim text
        if (sttInterimText) {
          const last = transcriptEntries.value[transcriptEntries.value.length - 1];
          if (last && last.partial) {
            last.partial = false;
          }
          sttInterimText = '';
        }
      }, TRANSCRIPT_SILENCE_DELAY);
    }
  }
}

/**
 * Toggle transcript listening on/off. When enabled, the audio driver's VAD
 * drives browser SpeechRecognition. When disabled, recognition stops.
 */
function toggleTranscriptListening() {
  transcriptListening.value = !transcriptListening.value;
  if (!transcriptListening.value) {
    stopStt();
    if (sttSilenceTimer) {
      clearTimeout(sttSilenceTimer);
      sttSilenceTimer = null;
    }
  }
}

ipc.on('audio-driver:mic-vad', onTranscriptVad);

// Auto-stop test recording when main process hits max duration
ipc.on('audio-driver:test-recording-stopped', () => {
  if (testRecording.value) {
    stopTestRecording();
  }
});

// ─── Mic test (live level meter) ────────────────────────────────

const micTesting = ref(false);
const micLevel = ref(0);
const micMuted = ref(false);
const micGain = ref(100);

const micDb = computed(() => {
  if (micLevel.value <= 0) return '-inf';
  const db = 20 * Math.log10(micLevel.value);
  return db > -100 ? db.toFixed(0) : '-inf';
});

let micAudioCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;
let micGainNode: GainNode | null = null;
let micStream: MediaStream | null = null;
let micAnimFrame: number | null = null;

function micPollLevel() {
  if (!micAnalyser) return;
  const data = new Float32Array(micAnalyser.fftSize);
  micAnalyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  micLevel.value = Math.min(1, Math.sqrt(sum / data.length) * 3);
  micAnimFrame = requestAnimationFrame(micPollLevel);
}

async function startMicTest() {
  try {
    const constraints: MediaStreamConstraints = {
      audio: audioInputDeviceId.value
        ? { deviceId: { exact: audioInputDeviceId.value }, autoGainControl: false, noiseSuppression: false, echoCancellation: false }
        : { autoGainControl: false, noiseSuppression: false, echoCancellation: false },
    };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
    micAudioCtx = new AudioContext();
    const source = micAudioCtx.createMediaStreamSource(micStream);

    micGainNode = micAudioCtx.createGain();
    micGainNode.gain.value = micMuted.value ? 0 : micGain.value / 100;

    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 2048;

    source.connect(micGainNode);
    micGainNode.connect(micAnalyser);

    micTesting.value = true;
    micPollLevel();
  } catch (e) {
    console.error('[AudioSettings] Mic test failed:', e);
    stopMicTest();
  }
}

function stopMicTest() {
  if (micAnimFrame !== null) cancelAnimationFrame(micAnimFrame);
  micAnimFrame = null;
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (micAudioCtx) {
    micAudioCtx.close().catch(() => {});
    micAudioCtx = null;
  }
  micAnalyser = null;
  micGainNode = null;
  micTesting.value = false;
  micLevel.value = 0;
}

function toggleMicTest() {
  if (micTesting.value) {
    stopMicTest();
  } else {
    startMicTest();
  }
}

function toggleMicMute() {
  micMuted.value = !micMuted.value;
  if (micGainNode) {
    micGainNode.gain.value = micMuted.value ? 0 : micGain.value / 100;
  }
}

function onMicGainChange() {
  if (micGainNode && !micMuted.value) {
    micGainNode.gain.value = micGain.value / 100;
  }
}

function onMicDeviceChange() {
  saveSettings();
  // Restart test with new device if currently testing
  if (micTesting.value) {
    stopMicTest();
    startMicTest();
  }
}

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

  // Check if audio-driver is already running
  try {
    const state = await ipc.invoke('audio-driver:get-state');
    driverRunning.value = !!state?.running;
  } catch { /* ignore */ }

  await fetchSpeakerDevices();
  await fetchSpeakerVolume();
});

onUnmounted(() => {
  stopMicTest();
  if (testRecording.value) {
    ipc.invoke('audio-driver:test-record-stop').catch(() => {});
    testRecording.value = false;
  }
  if (testRecordTimer) {
    clearInterval(testRecordTimer);
    testRecordTimer = null;
  }
  ipc.removeListener('audio-driver:mic-vad', onMicVad);
  ipc.removeListener('audio-driver:mic-vad', onTranscriptVad);
  ipc.removeListener('audio-driver:speaker-level', onSpeakerLevel);
  ipc.removeListener('audio-driver:speaker-level', onSpeakerLevelForMeter);
  ipc.removeListener('audio-driver:volume-changed', onVolumeChanged);
  ipc.removeListener('audio-driver:state', onDriverState);
  ipc.removeAllListeners('audio-driver:test-recording-stopped');
  stopStt();
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

// ── Mic test & meter ──

.mic-test-controls {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.btn-active {
  background: var(--status-warning, #f59e0b) !important;
  color: #fff !important;
  border-color: var(--status-warning, #f59e0b) !important;
}

.mic-meter-section {
  margin-bottom: 1rem;
}

.mic-meter-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.mic-meter-label {
  width: 40px;
  font-size: var(--fs-body-sm);
  font-weight: 500;
  color: var(--text-muted, var(--muted));
  flex-shrink: 0;
}

.mic-meter-track {
  flex: 1;
  max-width: 360px;
  height: 12px;
  border-radius: 6px;
  background: var(--bg-surface, var(--input-border, rgba(0,0,0,0.1)));
  overflow: hidden;
}

.mic-meter-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.05s linear;
  min-width: 0;
}

.meter-green {
  background: var(--status-success, #22c55e);
}

.meter-yellow {
  background: var(--status-warning, #f59e0b);
}

.meter-red {
  background: var(--status-error, #ef4444);
}

.mic-meter-db {
  width: 50px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.mic-gain-slider {
  flex: 1;
  max-width: 360px;
  accent-color: var(--accent-primary, var(--primary, #3b82f6));
}

// ── Audio driver pipeline ──

.pipeline-section {
  margin-top: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  background: var(--bg-surface, var(--card-bg, transparent));
}

.pipeline-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;

  &:last-child {
    margin-bottom: 0;
  }
}

.pipeline-label {
  width: 80px;
  font-size: var(--fs-body-sm);
  font-weight: 500;
  color: var(--text-muted, var(--muted));
  flex-shrink: 0;
}

.pipeline-value {
  width: 60px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.vad-indicator {
  display: inline-block;
  font-size: var(--fs-body-sm);
  font-weight: 600;
  padding: 0.2rem 0.75rem;
  border-radius: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.vad-speaking {
  background: var(--bg-success, rgba(34, 197, 94, 0.15));
  color: var(--status-success, #22c55e);
  animation: vad-pulse 0.8s ease-in-out infinite alternate;
}

.vad-silent {
  background: var(--bg-surface, rgba(0, 0, 0, 0.05));
  color: var(--text-muted, var(--muted));
}

.vad-fan {
  background: var(--bg-warning, rgba(245, 158, 11, 0.15));
  color: var(--status-warning, #f59e0b);
  margin-left: 0.5rem;
}

@keyframes vad-pulse {
  from { opacity: 0.8; }
  to { opacity: 1; }
}

.meter-blue {
  background: var(--accent-primary, var(--primary, #3b82f6));
}

.pipeline-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-default, var(--input-border));
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
}

.stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, var(--muted));
}

.stat-value {
  font-size: var(--fs-body-sm);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary, var(--body-text));
}

.btn-active-green {
  background: var(--status-success, #22c55e) !important;
  color: #fff !important;
  border-color: var(--status-success, #22c55e) !important;
}

.btn-active-red {
  background: var(--status-error, #ef4444) !important;
  color: #fff !important;
  border-color: var(--status-error, #ef4444) !important;
}

// ── Test recording progress ──

.test-progress-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
  max-width: 460px;
}

// ── Live Transcript ──

.transcript-area {
  height: 200px;
  overflow-y: auto;
  background: var(--bg-surface, var(--card-bg, transparent));
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-size: var(--fs-body);
  line-height: 1.6;
}

.transcript-empty {
  color: var(--text-muted, var(--muted));
  font-style: italic;
  font-size: var(--fs-body-sm);
}

.transcript-entry {
  margin-bottom: 0.5rem;
  &:last-child { margin-bottom: 0; }
}

.transcript-speaker {
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent-primary, var(--primary, #3b82f6));
  margin-right: 0.5rem;
}

.transcript-text {
  color: var(--text-primary, var(--body-text));
  word-wrap: break-word;
}

.transcript-partial {
  .transcript-text {
    color: var(--text-muted, var(--muted));
    font-style: italic;
  }
}

// ── Speaker meter ──

.speaker-meter-container {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: 500px;
}

.speaker-meter-track {
  flex: 1;
  height: 16px;
  border-radius: 8px;
  background: var(--bg-surface, var(--input-border, rgba(0, 0, 0, 0.1)));
  overflow: hidden;
  position: relative;
}

.speaker-meter-fill {
  height: 100%;
  border-radius: 8px;
  transition: width 0.05s linear;
  min-width: 0;
}

.speaker-meter-peak-indicator {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: var(--text-primary, var(--body-text));
  transition: left 0.05s linear, opacity 0.3s;
}

.speaker-meter-db {
  width: 55px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

// ── Speaker volume controls ──

.speaker-volume-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.icon-btn-lg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--border-default, var(--input-border));
  background: var(--bg-page, var(--input-bg));
  color: var(--text-primary, var(--body-text));
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: var(--bg-surface-hover, var(--nav-active));
    border-color: var(--accent-primary, var(--primary, #3b82f6));
  }

  &.icon-btn-muted {
    background: var(--status-error, #ef4444);
    color: #fff;
    border-color: var(--status-error, #ef4444);
  }
}

.speaker-volume-label {
  min-width: 60px;
  text-align: center;
  font-size: var(--fs-body);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary, var(--body-text));
}
</style>
