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
             Microphone Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'microphone'"
          class="tab-content"
        >
          <h2>Microphone</h2>

          <!-- ── Permission gate: hide settings until mic access is granted ── -->
          <div
            v-if="micPermission !== 'granted'"
            class="setup-gate"
          >
            <p class="setup-gate-description">
              Sulla Desktop needs microphone access for voice chat, transcription,
              and capture features.
            </p>
            <div
              v-if="micError"
              class="status-banner banner-error"
              style="margin-bottom: 1rem;"
            >
              <span class="banner-text">{{ micError }}</span>
            </div>
            <button
              v-if="micPermission === 'not-determined' || micPermission === 'unknown'"
              class="action-btn btn-primary btn-lg"
              :disabled="micPermissionChecking"
              @click="requestMicPermission"
            >
              {{ micPermissionChecking ? 'Requesting...' : 'Enable Microphone' }}
            </button>
            <div
              v-else
              class="setup-gate-denied"
            >
              <p>
                Microphone access was denied. To fix this:
              </p>
              <ol>
                <li>Open <strong>System Settings</strong></li>
                <li>Go to <strong>Privacy &amp; Security &gt; Microphone</strong></li>
                <li>Enable <strong>Sulla Desktop</strong></li>
                <li>
                  <button
                    class="action-btn"
                    @click="checkMicPermission"
                  >
                    {{ micPermissionChecking ? 'Checking...' : 'Check Again' }}
                  </button>
                </li>
              </ol>
            </div>
          </div>

          <!-- ── Mic settings (only shown when permission is granted) ── -->
          <template v-else>
            <p class="description">
              These settings apply to all voice features: chat, teleprompter,
              capture studio, and secretary mode.
            </p>

            <!-- Mic error banner -->
            <div
              v-if="micError"
              class="status-banner banner-error"
            >
              <span class="banner-text">{{ micError }}</span>
            </div>

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

          <!-- ── Microphone Enable ── -->
          <div class="setting-section">
            <h3>Microphone</h3>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': micRunning }"
                @click="toggleMicDriver"
              >
                {{ micRunning ? 'Stop Microphone' : 'Test Microphone' }}
              </button>
            </div>

            <!-- Pipeline meters (visible when mic is running) -->
            <div
              v-if="micRunning"
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

              <!-- Scrolling waveform -->
              <canvas
                ref="micWaveformCanvas"
                class="waveform-canvas"
                height="64"
              />

              <!-- Test recording controls -->
              <div class="test-recording-section">
                <div class="test-recording-header">
                  <select
                    v-model="micTestMode"
                    class="setting-select"
                    :disabled="micTestRecording"
                  >
                    <option value="raw">Studio Quality — Raw (ASMR)</option>
                    <option value="noise-reduction">Studio Quality — Voice (Noise Reduction)</option>
                    <option value="voice-compressed">Studio Quality — Voice + Compression</option>
                    <option value="streaming">Compressed — Streaming</option>
                    <option value="streaming-voice">Compressed — Voice (Streaming)</option>
                  </select>
                </div>

                <div class="mic-test-controls">
                  <button
                    class="action-btn"
                    :class="{ 'btn-active-red': micTestRecording }"
                    @click="toggleMicTestRecording"
                  >
                    {{ micTestRecording ? 'Stop Recording' : 'Record Test' }}
                  </button>
                  <span
                    v-if="micTestRecording"
                    class="recording-timer"
                  >
                    {{ micTestDuration }}
                  </span>
                </div>

                <!-- Playback -->
                <div
                  v-if="micTestAudioUrl"
                  class="playback-row"
                >
                  <span class="playback-label">{{ micTestModeLabel }}</span>
                  <audio
                    :src="micTestAudioUrl"
                    controls
                    class="playback-audio"
                  />
                </div>
              </div>
            </div>

            <p
              v-if="!micRunning"
              class="description"
            >
              Enable the microphone to see the full VAD pipeline: mic level,
              noise floor, speech detection, and spectral analysis. This is
              the same pipeline used by voice chat and dictation.
            </p>
          </div>

          </template>
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
             Speaker Tab
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'speaker'"
          class="tab-content"
        >
          <h2>Speaker</h2>

          <!-- ── Install gate: hide settings until loopback driver is installed ── -->
          <div
            v-if="loopbackInstalled === false"
            class="setup-gate"
          >
            <p class="setup-gate-description">
              The speaker capture driver requires BlackHole, a virtual audio
              loopback device for capturing system audio.
            </p>
            <div
              v-if="loopbackError"
              class="status-banner banner-error"
              style="margin-bottom: 1rem;"
            >
              <span class="banner-text">{{ loopbackError }}</span>
            </div>
            <button
              class="action-btn btn-primary btn-lg"
              :disabled="loopbackInstalling"
              @click="installLoopback"
            >
              {{ loopbackInstalling ? 'Installing...' : 'Install Audio Driver' }}
            </button>
            <p class="setup-gate-hint">
              Installs BlackHole via Homebrew. Requires
              <a
                href="https://brew.sh"
                target="_blank"
              >Homebrew</a>.
            </p>
            <button
              class="action-btn"
              style="margin-top: 0.5rem;"
              @click="checkLoopbackStatus"
            >
              Check Again
            </button>
          </div>

          <!-- Loading state -->
          <div
            v-else-if="loopbackInstalled === null"
            class="setup-gate"
          >
            <p class="setup-gate-description">
              Checking audio driver status...
            </p>
          </div>

          <!-- ── Speaker settings (only shown when loopback is installed) ── -->
          <template v-else>
            <p class="description">
              Configure your system speaker output. The speaker driver captures
              system audio via a virtual loopback device for meeting transcription.
            </p>

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

          <!-- Test Speaker -->
          <div class="setting-section">
            <h3>Test</h3>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': speakerRunning }"
                :disabled="speakerTransitioning"
                @click="toggleSpeakerDriver"
              >
                {{ speakerTransitioning ? (speakerRunning ? 'Disabling...' : 'Enabling...') : speakerRunning ? 'Stop Speaker' : 'Test Speaker' }}
              </button>
            </div>
            <div
              v-if="speakerRunning"
              class="speaker-meter-container"
              style="margin-top: 0.75rem;"
            >
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
              v-if="!speakerRunning"
              class="description"
            >
              Starts the loopback capture driver to verify speaker audio is
              being captured correctly. Play some audio to see the level meter.
            </p>
          </div>
          </template>
        </div>

        <!-- ═══════════════════════════════════════════════════════════
             Transcription Tab — whisper.cpp lifecycle
             ═══════════════════════════════════════════════════════════ -->
        <div
          v-if="currentNav === 'transcription'"
          class="tab-content"
        >
          <h2>Transcription</h2>
          <p class="description">
            Local speech-to-text powered by whisper.cpp. Runs entirely on your
            machine &mdash; no network, no API keys, no data sent anywhere.
          </p>

          <!-- ── Progress / Activity Log ── -->
          <div
            v-if="whisperBusy"
            class="setting-section"
          >
            <div class="whisper-activity">
              <div class="whisper-activity-header">
                <span class="whisper-activity-title">{{ whisperProgressPhase }}</span>
                <span
                  v-if="whisperProgressPct > 0"
                  class="whisper-activity-pct"
                >{{ Math.round(whisperProgressPct) }}%</span>
              </div>
              <!-- Determinate progress bar (download with known %) -->
              <div
                v-if="whisperProgressPct > 0"
                class="mic-meter-track"
              >
                <div
                  class="mic-meter-fill meter-blue"
                  :style="{ width: whisperProgressPct + '%' }"
                />
              </div>
              <!-- Indeterminate progress bar (brew install, no known %) -->
              <div
                v-if="whisperProgressPct <= 0"
                class="mic-meter-track"
              >
                <div class="mic-meter-fill meter-blue meter-indeterminate" />
              </div>
              <div class="whisper-log">
                <div
                  v-for="(line, i) in whisperLogLines"
                  :key="i"
                  class="whisper-log-line"
                >
                  {{ line }}
                </div>
              </div>
            </div>
          </div>

          <!-- ── Install gate: shown until whisper.cpp is installed ── -->
          <div
            v-if="!whisperInstalled && !whisperBusy"
            class="setup-gate"
          >
            <p class="setup-gate-description">
              Local transcription requires whisper.cpp. It runs entirely on
              your machine &mdash; no network, no API keys.
            </p>
            <div
              v-if="whisperError"
              class="status-banner banner-error"
              style="margin-bottom: 1rem;"
            >
              <span class="banner-text">{{ whisperError }}</span>
            </div>
            <button
              class="action-btn btn-primary btn-lg"
              @click="installWhisper"
            >
              Install whisper.cpp
            </button>
            <p class="setup-gate-hint">
              Installs via Homebrew. Requires
              <a
                href="https://brew.sh"
                target="_blank"
              >Homebrew</a>.
            </p>
          </div>

          <!-- ── Engine Status (installed) ── -->
          <div
            v-if="whisperInstalled"
            class="setting-section"
          >
            <h3>whisper.cpp Engine</h3>
            <div
              v-if="whisperVersion"
              class="status-row"
            >
              <span class="status-label">Version:</span>
              <span class="status-value">{{ whisperVersion }}</span>
            </div>
            <div
              v-if="whisperBinaryPath"
              class="status-row"
            >
              <span class="status-label">Path:</span>
              <span class="status-value status-path">{{ whisperBinaryPath }}</span>
            </div>
            <div class="mic-test-controls">
              <button
                class="action-btn btn-danger"
                :disabled="whisperBusy"
                @click="confirmRemoveWhisper"
              >
                Uninstall
              </button>
            </div>
          </div>

          <!-- ── Model Management (only when installed) ── -->
          <div
            v-if="whisperInstalled"
            class="setting-section"
          >
            <h3>Models</h3>
            <p class="description">
              Download models to enable local transcription. Select one as
              the active model. Larger models are more accurate but use more
              memory and CPU.
            </p>

            <!-- Downloaded models list -->
            <div
              v-if="whisperModels.length > 0"
              class="model-list"
            >
              <div
                v-for="model in whisperModels"
                :key="model"
                class="model-item"
                :class="{ 'model-active': model === activeWhisperModel }"
              >
                <div class="model-info">
                  <div class="model-name-row">
                    <span class="model-name">{{ model }}</span>
                    <span
                      v-if="model === activeWhisperModel"
                      class="status-badge badge-primary"
                    >Active</span>
                  </div>
                  <span class="model-meta">{{ getModelMeta(model) }}</span>
                </div>
                <div class="model-actions">
                  <button
                    v-if="model !== activeWhisperModel"
                    class="action-btn-small"
                    :disabled="whisperBusy"
                    @click="setActiveWhisperModel(model)"
                  >
                    Use
                  </button>
                  <button
                    class="action-btn-small btn-danger-text"
                    :disabled="whisperBusy || whisperTranscribing"
                    @click="deleteWhisperModel(model)"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
            <p
              v-if="whisperModels.length === 0"
              class="description"
            >
              No models downloaded yet. Download one below to get started.
            </p>

            <!-- Download new model -->
            <div
              v-if="availableWhisperModels.length > 0"
              class="voice-select-row"
            >
              <select
                v-model="whisperModelToDownload"
                class="setting-select"
                :disabled="whisperBusy"
              >
                <option
                  v-for="m in availableWhisperModels"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.id }} ({{ m.size }}, {{ m.speed }}, {{ m.lang }})
                </option>
              </select>
              <button
                class="action-btn"
                :disabled="whisperBusy"
                @click="downloadWhisperModel"
              >
                {{ whisperDownloading ? 'Downloading...' : 'Download' }}
              </button>
            </div>
            <p
              v-if="availableWhisperModels.length === 0 && whisperModels.length > 0"
              class="description"
            >
              All available models are downloaded.
            </p>
          </div>

          <!-- ── Test Transcription (only when installed + has models) ── -->
          <div
            v-if="whisperInstalled && whisperModels.length > 0"
            class="setting-section"
          >
            <h3>Test</h3>
            <p class="description">
              Starts the microphone and whisper engine to verify transcription
              is working. Speak into your mic to see results below.
            </p>
            <div class="mic-test-controls">
              <button
                class="action-btn"
                :class="{ 'btn-active-green': whisperTranscribing }"
                :disabled="whisperBusy"
                @click="toggleWhisperTest"
              >
                {{ whisperTranscribing ? 'Stop Test' : 'Test Transcription' }}
              </button>
            </div>

            <!-- Waveform + meter (visible when transcribing) -->
            <div
              v-if="whisperTranscribing"
              class="pipeline-section"
              style="margin-top: 0.75rem;"
            >
              <div class="pipeline-row">
                <span
                  class="pipeline-indicator"
                  :class="vadSpeaking ? 'indicator-green' : 'indicator-dim'"
                />
                <span class="pipeline-label">{{ vadSpeaking ? 'Speaking' : 'Silent' }}</span>
                <span class="pipeline-value">{{ driverMicDb }} dB</span>
              </div>
              <canvas
                ref="whisperWaveformCanvas"
                class="waveform-canvas"
                height="64"
              />
            </div>

            <!-- Pipeline status (polled while transcribing) -->
            <div
              v-if="whisperTranscribing && transcribeStats"
              class="pipeline-section"
              style="margin-top: 0.5rem;"
            >
              <div class="pipeline-row">
                <span
                  class="pipeline-indicator"
                  :class="transcribeStats.active ? 'indicator-green' : 'indicator-dim'"
                />
                <span class="pipeline-label">Whisper Engine</span>
                <span class="pipeline-value">{{ transcribeStats.active ? 'Active' : 'Inactive' }}</span>
              </div>
              <div class="pipeline-row">
                <span
                  class="pipeline-indicator"
                  :class="transcribeStats.transcribing ? 'indicator-yellow' : 'indicator-dim'"
                />
                <span class="pipeline-label">Processing</span>
                <span class="pipeline-value">{{ transcribeStats.transcribing ? 'Transcribing...' : 'Waiting for audio' }}</span>
              </div>
              <div class="pipeline-row">
                <span class="pipeline-label">Mic data received</span>
                <span class="pipeline-value">{{ (transcribeStats.micBytesReceived / 1024).toFixed(0) }} KB ({{ transcribeStats.micChunksReceived }} chunks)</span>
              </div>
            </div>

            <!-- Live transcript output -->
            <div
              v-if="whisperTranscribing || whisperTestEntries.length > 0"
              class="transcript-area"
              style="margin-top: 0.75rem;"
            >
              <div
                v-if="whisperTestEntries.length === 0"
                class="transcript-empty"
              >
                Listening... speak into your microphone.
              </div>
              <div
                v-for="(entry, i) in whisperTestEntries"
                :key="i"
                class="transcript-entry"
                :class="{ 'transcript-partial': entry.partial }"
              >
                <span class="transcript-speaker">{{ entry.speaker }}</span>
                <span class="transcript-text">{{ entry.text }}</span>
              </div>
            </div>
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

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useTheme } from '../composables/useTheme';

// The audio-driver IPC channels are not yet in the typed IpcRendererEvents
// interface. Use an untyped reference for audio-driver-specific calls.
const ipc = ipcRenderer as any;

useTheme();

// ─── Navigation ─────────────────────────────────────────────────

const navItems = [
  { id: 'microphone', name: 'Microphone' },
  { id: 'transcription', name: 'Transcription' },
  { id: 'tts', name: 'Text-to-Speech' },
  { id: 'speaker', name: 'Speaker' },
  { id: 'secretary', name: 'Secretary Mode' },
];

const currentNav = ref('microphone');

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

// ─── Permissions & install status ────────────────────────────────

const micPermission = ref<string>('unknown'); // 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
const micPermissionChecking = ref(false);
const micError = ref<string | null>(null);
const loopbackInstalled = ref<boolean | null>(null); // null = not checked yet
const loopbackName = ref<string | null>(null);
const loopbackInstalling = ref(false);
const loopbackError = ref<string | null>(null);

async function checkMicPermission() {
  micPermissionChecking.value = true;
  try {
    const result = await ipc.invoke('audio-driver:check-permissions');
    micPermission.value = result?.microphone || 'unknown';
  } catch (e: any) {
    console.error('[AudioSettings] checkMicPermission error:', e);
  } finally {
    micPermissionChecking.value = false;
  }
}

async function requestMicPermission() {
  micPermissionChecking.value = true;
  micError.value = null;
  try {
    const result = await ipc.invoke('audio-driver:request-mic-permission');
    if (result?.granted) {
      micPermission.value = 'granted';
    } else {
      micPermission.value = result?.status || 'denied';
      if (result?.openSettings) {
        micError.value = 'Microphone access was denied. Open System Settings > Privacy & Security > Microphone to grant access.';
      }
    }
  } catch (e: any) {
    console.error('[AudioSettings] requestMicPermission error:', e);
  } finally {
    micPermissionChecking.value = false;
  }
}

async function checkLoopbackStatus() {
  try {
    const result = await ipc.invoke('audio-driver:check-loopback');
    loopbackInstalled.value = result?.installed ?? false;
    loopbackName.value = result?.name || null;
  } catch (e: any) {
    console.error('[AudioSettings] checkLoopbackStatus error:', e);
  }
}

async function installLoopback() {
  loopbackInstalling.value = true;
  loopbackError.value = null;
  try {
    const result = await ipc.invoke('audio-driver:install-loopback');
    if (result?.ok) {
      loopbackInstalled.value = true;
      loopbackName.value = result?.name || null;
    } else {
      loopbackError.value = result?.error || 'Installation failed';
    }
  } catch (e: any) {
    loopbackError.value = e.message || 'Installation failed';
    console.error('[AudioSettings] installLoopback error:', e);
  } finally {
    loopbackInstalling.value = false;
  }
}

// Listen for mic errors from the renderer (e.g. getUserMedia denied)
function onMicError(_event: any, data: any) {
  console.error('[AudioSettings] mic-error:', data);
  micError.value = data?.error === 'microphone-permission-denied'
    ? 'Microphone permission denied. Open System Settings > Privacy & Security > Microphone to grant access.'
    : `Microphone error: ${data?.message || data?.error || 'unknown'}`;
  micRunning.value = false;
}
ipc.on('audio-driver:mic-error', onMicError);

// ─── Audio Driver pipeline ──────────────────────────────────────

const micRunning = ref(false);
const speakerRunning = ref(false);
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

let vadFrameCount = 0;
function onMicVad(_event: any, data: { speaking: boolean; level: number; fanNoise: boolean; noiseFloor?: number; zcr?: number; variance?: number; pitch?: number | null; centroid?: number }) {
  if (!data) return;
  vadFrameCount++;
  if (vadFrameCount <= 5 || vadFrameCount % 300 === 0) {
    console.log('[AudioSettings] onMicVad frame', { frame: vadFrameCount, speaking: data.speaking, level: data.level?.toFixed(3) });
  }
  driverMicLevel.value = data.level;
  vadSpeaking.value = data.speaking;
  vadFanNoise.value = data.fanNoise;
  if (data.noiseFloor !== undefined) vadNoiseFloor.value = data.noiseFloor;
  if (data.zcr !== undefined) vadZcr.value = data.zcr.toFixed(3);
  if (data.variance !== undefined) vadVariance.value = data.variance.toFixed(6);
  if (data.pitch !== undefined) vadPitch.value = data.pitch !== null ? `${data.pitch.toFixed(0)} Hz` : '--';
  if (data.centroid !== undefined) vadCentroid.value = data.centroid.toFixed(4);

  // Feed scrolling waveform
  pushWaveformSample(data.level, data.speaking);
}

// ─── Scrolling waveform ──────────────────────────────────────────

const micWaveformCanvas = ref<HTMLCanvasElement | null>(null);
const whisperWaveformCanvas = ref<HTMLCanvasElement | null>(null);

const WAVEFORM_HISTORY = 300; // ~5 seconds at 60fps
const waveformSamples: Array<{ level: number; speaking: boolean }> = [];

function pushWaveformSample(level: number, speaking: boolean) {
  waveformSamples.push({ level, speaking });
  if (waveformSamples.length > WAVEFORM_HISTORY) {
    waveformSamples.shift();
  }
  drawWaveform(micWaveformCanvas.value);
  drawWaveform(whisperWaveformCanvas.value);
}

function drawWaveform(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Match canvas pixel size to layout size
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h / 2;
  const samples = waveformSamples;
  const len = samples.length;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Center line
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  if (len < 2) return;

  // Draw waveform bars (like a DAW track)
  const barWidth = w / WAVEFORM_HISTORY;
  const startX = w - (len * barWidth);

  for (let i = 0; i < len; i++) {
    const s = samples[i];
    const x = startX + (i * barWidth);
    // Map level (0-1) to amplitude. Use sqrt for better visual dynamic range
    const amp = Math.sqrt(s.level) * midY * 0.9;

    if (s.speaking) {
      ctx.fillStyle = 'rgba(52, 211, 153, 0.8)'; // green when speaking
    } else if (s.level > 0.01) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.5)'; // gray for ambient noise
    } else {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.15)'; // dim for silence
    }

    // Draw mirrored bar (top and bottom from center)
    const barW = Math.max(1, barWidth - 0.5);
    ctx.fillRect(x, midY - amp, barW, amp * 2);
  }
}

function onSpeakerLevel(_event: any, data: { rms: number }) {
  if (!data) return;
  driverSpeakerLevel.value = typeof data === 'number' ? data : data.rms;
}

function onDriverState(_event: any, state: { running: boolean; micRunning?: boolean; speakerRunning?: boolean } | undefined) {
  if (!state) return;
  // Support both old (single `running`) and new (split) state shapes
  micRunning.value = state.micRunning ?? state.running;
  speakerRunning.value = state.speakerRunning ?? false;
  if (!state.running) {
    driverMicLevel.value = 0;
    driverSpeakerLevel.value = 0;
    vadSpeaking.value = false;
    vadFanNoise.value = false;
    vadNoiseFloor.value = 0;
  }
}

async function toggleMicDriver() {
  micError.value = null;
  if (micRunning.value) {
    // Stop any active recording first
    if (micTestRecording.value) {
      await stopMicTestRecording();
    }
    await ipc.invoke('audio-driver:stop-mic', 'audio-settings-test');
    micRunning.value = false;
  } else {
    // Request both PCM formats so raw + gated are both available
    const result = await ipc.invoke('audio-driver:start-mic', 'audio-settings-test', ['pcm-s16le', 'pcm-s16le-raw']);
    if (result?.ok === false && result?.error === 'microphone-permission-denied') {
      micPermission.value = 'denied';
      micError.value = 'Microphone permission denied. Open System Settings > Privacy & Security > Microphone to grant access.';
      return;
    }
    micRunning.value = true;
  }
}

// ─── Mic test recording ─────────────────────────────────────────

const MIC_TEST_MODES = {
  'raw':              'Studio Quality — Raw (ASMR)',
  'noise-reduction':  'Studio Quality — Voice (Noise Reduction)',
  'voice-compressed': 'Studio Quality — Voice + Compression',
  'streaming':        'Compressed — Streaming',
  'streaming-voice':  'Compressed — Voice (Streaming)',
} as const;

type MicTestModeKey = keyof typeof MIC_TEST_MODES;

const micTestMode = ref<MicTestModeKey>('raw');
const micTestRecording = ref(false);
const micTestDuration = ref('0:00');
const micTestAudioUrl = ref<string | null>(null);
const micTestModeLabel = ref('');
let micTestTimer: ReturnType<typeof setInterval> | null = null;
let micTestSeconds = 0;

/** Map UI mode to the controller recording mode */
function getRecordingMode(mode: MicTestModeKey): string {
  switch (mode) {
  case 'raw':              return 'raw';
  case 'noise-reduction':  return 'noise-reduction';
  case 'voice-compressed': return 'noise-reduction'; // same PCM path, compression applied later
  case 'streaming':        return 'raw';             // TODO: WebM/Opus path
  case 'streaming-voice':  return 'noise-reduction'; // TODO: WebM/Opus + noise reduction
  default:                 return 'raw';
  }
}

async function startMicTestRecording() {
  // Clear previous
  if (micTestAudioUrl.value) { URL.revokeObjectURL(micTestAudioUrl.value); micTestAudioUrl.value = null; }

  const mode = getRecordingMode(micTestMode.value);
  micTestModeLabel.value = MIC_TEST_MODES[micTestMode.value];
  console.log('[AudioSettings] Starting test recording', { uiMode: micTestMode.value, recordMode: mode });
  await ipc.invoke('audio-driver:test-record-start', mode);
  micTestRecording.value = true;
  micTestSeconds = 0;
  micTestDuration.value = '0:00';
  micTestTimer = setInterval(() => {
    micTestSeconds++;
    const m = Math.floor(micTestSeconds / 60);
    const s = micTestSeconds % 60;
    micTestDuration.value = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

async function stopMicTestRecording() {
  if (micTestTimer) { clearInterval(micTestTimer); micTestTimer = null; }
  micTestRecording.value = false;

  console.log('[AudioSettings] Stopping test recording');
  const result = await ipc.invoke('audio-driver:test-record-stop');
  console.log('[AudioSettings] test-record-stop result', { hasRaw: !!result?.raw, hasReduced: !!result?.noiseReduced });

  // Pick the right audio based on mode
  const audioData = result?.noiseReduced || result?.raw;
  if (audioData) {
    const blob = new Blob([audioData], { type: 'audio/wav' });
    micTestAudioUrl.value = URL.createObjectURL(blob);
  }
}

function toggleMicTestRecording() {
  if (micTestRecording.value) {
    stopMicTestRecording();
  } else {
    startMicTestRecording();
  }
}

const speakerTransitioning = ref(false);

async function toggleSpeakerDriver() {
  if (speakerTransitioning.value) return; // prevent double-click
  speakerTransitioning.value = true;
  try {
    if (speakerRunning.value) {
      // Don't await — deactivate can take 5-15s (Swift compilation).
      // Update UI immediately so the user isn't stuck.
      speakerRunning.value = false;
      ipc.invoke('audio-driver:stop-speaker', 'audio-settings-test').catch((e: any) => {
        console.warn('[AudioSettings] stop-speaker error:', e);
      });
      // Give the IPC a moment to dispatch, then clear transitioning
      setTimeout(() => { speakerTransitioning.value = false; }, 500);
    } else {
      await ipc.invoke('audio-driver:start-speaker', 'audio-settings-test');
      speakerRunning.value = true;
      speakerTransitioning.value = false;
    }
  } catch (e: any) {
    console.error('[AudioSettings] toggleSpeakerDriver error:', e);
    speakerTransitioning.value = false;
  }
}

// Register driver IPC listeners immediately (settings page should always reflect driver state)
ipc.on('audio-driver:mic-vad', onMicVad);
ipc.on('audio-driver:speaker-level', onSpeakerLevel);
ipc.on('audio-driver:state', onDriverState);

// ─── Whisper.cpp (local transcription) ─────────────────────────

// ── State ──

const whisperInstalled = ref(false);
const whisperVersion = ref('');
const whisperBinaryPath = ref('');
const whisperModels = ref<string[]>([]);
const whisperInstalling = ref(false);
const whisperDetecting = ref(false);
const whisperDownloading = ref(false);
const whisperError = ref<string | null>(null);
const whisperModelToDownload = ref('base.en');
const whisperTranscribing = ref(false);
const whisperTranscribeMode = ref('conversation');
const activeWhisperModel = ref('');

// ── Model catalog ──

const WHISPER_MODEL_CATALOG: Array<{ id: string; size: string; speed: string; lang: string }> = [
  { id: 'tiny.en',   size: '75 MB',  speed: 'fastest',  lang: 'English only' },
  { id: 'tiny',      size: '75 MB',  speed: 'fastest',  lang: 'multilingual' },
  { id: 'base.en',   size: '141 MB', speed: 'fast',     lang: 'English only' },
  { id: 'base',      size: '141 MB', speed: 'fast',     lang: 'multilingual' },
  { id: 'small.en',  size: '466 MB', speed: 'balanced', lang: 'English only' },
  { id: 'small',     size: '466 MB', speed: 'balanced', lang: 'multilingual' },
  { id: 'medium.en', size: '1.5 GB', speed: 'accurate', lang: 'English only' },
  { id: 'medium',    size: '1.5 GB', speed: 'accurate', lang: 'multilingual' },
  { id: 'large',     size: '2.9 GB', speed: 'most accurate', lang: 'multilingual' },
];

const availableWhisperModels = computed(() => {
  const available = WHISPER_MODEL_CATALOG.filter(m => !whisperModels.value.includes(m.id));
  // Auto-select first available if current selection is already downloaded
  if (available.length > 0 && !available.find(m => m.id === whisperModelToDownload.value)) {
    whisperModelToDownload.value = available[0].id;
  }
  return available;
});

function getModelMeta(modelId: string): string {
  const m = WHISPER_MODEL_CATALOG.find(c => c.id === modelId);
  return m ? `${m.size} · ${m.speed} · ${m.lang}` : '';
}

function setActiveWhisperModel(model: string) {
  activeWhisperModel.value = model;
  ipc.invoke('sulla-settings-set', 'audioWhisperModel', model);
}

// ── Transcribe pipeline stats (polled while transcribing) ──
const transcribeStats = ref<{ active: boolean; transcribing: boolean; micBytesReceived: number; micChunksReceived: number } | null>(null);
let transcribeStatsPollTimer: ReturnType<typeof setInterval> | null = null;

function startTranscribeStatsPoll() {
  transcribeStats.value = null;
  transcribeStatsPollTimer = setInterval(async () => {
    try {
      transcribeStats.value = await ipc.invoke('audio-driver:transcribe-status');
    } catch { /* ignore */ }
  }, 500);
}

function stopTranscribeStatsPoll() {
  if (transcribeStatsPollTimer) {
    clearInterval(transcribeStatsPollTimer);
    transcribeStatsPollTimer = null;
  }
  transcribeStats.value = null;
}

// ── Progress tracking ──

const whisperProgressPhase = ref('');
const whisperProgressPct = ref(-1);
const whisperLogLines = ref<string[]>([]);
const whisperBusy = computed(() => whisperInstalling.value || whisperDownloading.value || whisperDetecting.value);

function addWhisperLog(line: string) {
  whisperLogLines.value.push(line);
  // Keep last 50 lines
  if (whisperLogLines.value.length > 50) {
    whisperLogLines.value.splice(0, whisperLogLines.value.length - 50);
  }
}

function clearWhisperLog() {
  whisperLogLines.value = [];
  whisperProgressPhase.value = '';
  whisperProgressPct.value = -1;
}

// ── Actions ──

async function detectWhisper() {
  whisperDetecting.value = true;
  try {
    const status = await ipc.invoke('audio-driver:whisper-detect');
    whisperInstalled.value = !!status?.available;
    whisperVersion.value = status?.version || '';
    whisperBinaryPath.value = status?.binaryPath || '';
    whisperModels.value = status?.models || [];
    // Auto-select first model if none is active or active model was deleted
    if (whisperModels.value.length > 0 && (!activeWhisperModel.value || !whisperModels.value.includes(activeWhisperModel.value))) {
      setActiveWhisperModel(whisperModels.value[0]);
    }
  } catch (e: any) {
    console.warn('[AudioSettings] whisper detect failed:', e);
  } finally {
    whisperDetecting.value = false;
  }
}

async function installWhisper() {
  whisperInstalling.value = true;
  whisperError.value = null;
  clearWhisperLog();
  whisperProgressPhase.value = 'Installing whisper.cpp';
  whisperProgressPct.value = 0;
  addWhisperLog('Starting Homebrew install...');
  try {
    const result = await ipc.invoke('audio-driver:whisper-install');
    if (result?.ok) {
      addWhisperLog('Installation complete.');
      await detectWhisper();
    } else {
      const msg = result?.error || 'Installation failed. Check that Homebrew is installed.';
      whisperError.value = msg;
      addWhisperLog(msg);
    }
  } catch (e: any) {
    whisperError.value = e.message || String(e);
    addWhisperLog(`Error: ${ e.message }`);
  } finally {
    whisperInstalling.value = false;
  }
}

function confirmRemoveWhisper() {
  if (!confirm('Uninstall whisper.cpp? This will remove the engine and all downloaded models.')) return;
  removeWhisper();
}

async function removeWhisper() {
  whisperInstalling.value = true; // reuse busy state
  clearWhisperLog();
  whisperProgressPhase.value = 'Uninstalling whisper.cpp';
  whisperProgressPct.value = 0;
  addWhisperLog('Removing via Homebrew...');
  try {
    await ipc.invoke('audio-driver:whisper-remove');
    addWhisperLog('Uninstalled.');
    await detectWhisper();
  } catch (e: any) {
    addWhisperLog(`Error: ${ e.message }`);
  } finally {
    whisperInstalling.value = false;
    setTimeout(clearWhisperLog, 3000);
  }
}

async function downloadWhisperModel() {
  whisperDownloading.value = true;
  clearWhisperLog();
  whisperProgressPhase.value = `Downloading ${ whisperModelToDownload.value }`;
  whisperProgressPct.value = 0;
  addWhisperLog(`Downloading model: ${ whisperModelToDownload.value }...`);
  try {
    const result = await ipc.invoke('audio-driver:whisper-download-model', whisperModelToDownload.value);
    if (result?.ok) {
      addWhisperLog('Download complete.');
      await detectWhisper();
    } else {
      addWhisperLog('Download failed.');
    }
  } catch (e: any) {
    addWhisperLog(`Error: ${ e.message }`);
  } finally {
    whisperDownloading.value = false;
  }
}

async function deleteWhisperModel(model: string) {
  if (!confirm(`Delete model "${ model }"? You can re-download it later.`)) return;
  addWhisperLog(`Deleting model: ${ model }...`);
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const modelsDir = `${ process.env.HOME }/.sulla/cache/whisper/models`;
    const modelFile = path.join(modelsDir, `ggml-${ model }.bin`);
    fs.unlinkSync(modelFile);
    addWhisperLog(`Deleted ${ model }.`);
    // If we deleted the active model, clear it (detectWhisper will auto-select another)
    if (activeWhisperModel.value === model) {
      activeWhisperModel.value = '';
    }
    await detectWhisper();
  } catch (e: any) {
    addWhisperLog(`Failed to delete: ${ e.message }`);
  }
}

interface WhisperTestEntry {
  speaker: string;
  text: string;
  partial: boolean;
}

const whisperTestEntries = ref<WhisperTestEntry[]>([]);

/**
 * Toggle whisper test — starts mic + whisper, shows transcript output.
 * Stops both when done.
 */
async function toggleWhisperTest() {
  console.log('[AudioSettings] toggleWhisperTest', { current: whisperTranscribing.value });
  if (whisperTranscribing.value) {
    // Stop whisper + mic
    console.log('[AudioSettings] Stopping whisper transcription...');
    await ipc.invoke('audio-driver:transcribe-stop');
    console.log('[AudioSettings] Stopping mic (whisper-test)...');
    await ipc.invoke('audio-driver:stop-mic', 'whisper-test');
    whisperTranscribing.value = false;
    micRunning.value = false;
    stopTranscribeStatsPoll();
    console.log('[AudioSettings] Whisper test stopped');
  } else {
    // Clear previous results
    whisperTestEntries.value = [];
    // Start mic first, then whisper
    console.log('[AudioSettings] Starting mic (whisper-test)...');
    const micResult = await ipc.invoke('audio-driver:start-mic', 'whisper-test', ['pcm-s16le']);
    console.log('[AudioSettings] start-mic result:', micResult);
    micRunning.value = true;
    console.log('[AudioSettings] Starting whisper transcription...', { mode: whisperTranscribeMode.value });
    const result = await ipc.invoke('audio-driver:transcribe-start', {
      mode: whisperTranscribeMode.value,
      model: activeWhisperModel.value || undefined,
    });
    console.log('[AudioSettings] transcribe-start result:', result);
    whisperTranscribing.value = !!result?.ok;
    if (result?.ok) {
      startTranscribeStatsPoll();
    } else {
      console.error('[AudioSettings] Whisper transcription failed to start');
    }
  }
}

// Capture whisper transcript events into the test area
function onWhisperTestTranscript(_event: any, msg: any) {
  if (!msg || !msg.text || !whisperTranscribing.value) return;

  const speaker = msg.channel_label || msg.speaker || 'You';
  const isPartial = msg.event_type === 'transcript_partial';
  const last = whisperTestEntries.value[whisperTestEntries.value.length - 1];

  if (isPartial) {
    if (last && last.partial) {
      last.text = msg.text;
    } else {
      whisperTestEntries.value.push({ speaker, text: msg.text, partial: true });
    }
  } else {
    if (last && last.partial) {
      last.text = msg.text;
      last.partial = false;
    } else {
      whisperTestEntries.value.push({ speaker, text: msg.text, partial: false });
    }
  }

  if (whisperTestEntries.value.length > 50) {
    whisperTestEntries.value.splice(0, whisperTestEntries.value.length - 50);
  }
}

ipc.on('gateway-transcript', onWhisperTestTranscript);

// ── IPC listeners ──

// Status updates (after install/remove/model download completes)
ipc.on('audio-driver:whisper-status', (_event: any, status: any) => {
  if (!status) return;
  whisperInstalled.value = !!status.available;
  whisperVersion.value = status.version || '';
  whisperBinaryPath.value = status.binaryPath || '';
  whisperModels.value = status.models || [];
});

// Progress updates (streaming from brew/curl)
ipc.on('audio-driver:whisper-progress', (_event: any, data: any) => {
  if (!data) return;
  if (data.status) {
    whisperProgressPhase.value = data.phase === 'install' ? 'Installing whisper.cpp'
      : data.phase === 'uninstall' ? 'Uninstalling whisper.cpp'
        : data.phase === 'download' ? `Downloading ${ data.model || 'model' }`
          : data.status;
    addWhisperLog(data.status);
  }
  if (typeof data.pct === 'number' && data.pct >= 0) {
    whisperProgressPct.value = data.pct;
  }
  if (data.pct === 100) {
    // Auto-clear progress after completion
    setTimeout(clearWhisperLog, 3000);
  }
});

function onMicDeviceChange() {
  saveSettings();
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
    activeWhisperModel.value = await ipcRenderer.invoke('sulla-settings-get', 'audioWhisperModel', '');
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
    micRunning.value = !!state?.micRunning || !!state?.running;
    speakerRunning.value = !!state?.speakerRunning;
    if (state?.permissions) {
      micPermission.value = state.permissions.microphone || 'unknown';
    }
  } catch { /* ignore */ }

  // Check permissions and loopback status on load
  await checkMicPermission();
  await checkLoopbackStatus();

  await fetchSpeakerDevices();
  await fetchSpeakerVolume();

  // Check whisper status
  await detectWhisper();

  // Check if whisper transcription is already running
  try {
    const tStatus = await ipc.invoke('audio-driver:transcribe-status');
    whisperTranscribing.value = !!tStatus?.active;
    if (tStatus?.mode) whisperTranscribeMode.value = tStatus.mode;
  } catch { /* ignore */ }
});

onUnmounted(() => {
  ipc.removeListener('audio-driver:mic-error', onMicError);
  ipc.removeListener('audio-driver:mic-vad', onMicVad);
  ipc.removeListener('audio-driver:speaker-level', onSpeakerLevel);
  ipc.removeListener('audio-driver:speaker-level', onSpeakerLevelForMeter);
  ipc.removeListener('audio-driver:volume-changed', onVolumeChanged);
  ipc.removeListener('audio-driver:state', onDriverState);
  ipc.removeAllListeners('audio-driver:whisper-status');
  ipc.removeAllListeners('audio-driver:whisper-progress');
  ipc.removeListener('gateway-transcript', onWhisperTestTranscript);
  stopTranscribeStatsPoll();
  if (whisperTranscribing.value) {
    ipc.invoke('audio-driver:transcribe-stop').catch(() => {});
  }
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

.banner-warning {
  background: var(--bg-warning, rgba(245, 158, 11, 0.1));
  color: var(--status-warning, #f59e0b);
  border: 1px solid var(--status-warning, #f59e0b);
}

.banner-error {
  background: rgba(239, 68, 68, 0.1);
  color: var(--status-error, #ef4444);
  border: 1px solid var(--status-error, #ef4444);
}

.banner-content {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.banner-text {
  display: block;
}

.badge-neutral {
  background: var(--bg-surface, rgba(128, 128, 128, 0.1));
  color: var(--text-muted, var(--muted));
}

// ── Setup gate (permission / install required) ──

.setup-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 3rem 2rem;
  min-height: 200px;
}

.setup-gate-description {
  font-size: var(--fs-body);
  color: var(--text-muted, var(--muted));
  margin-bottom: 1.5rem;
  max-width: 400px;
  line-height: 1.5;
}

.setup-gate-denied {
  text-align: left;
  max-width: 400px;

  p { margin-bottom: 0.5rem; }

  ol {
    margin: 0;
    padding-left: 1.25rem;
    line-height: 2;
  }
}

.setup-gate-hint {
  font-size: var(--fs-small, 0.8rem);
  color: var(--text-muted, var(--muted));
  margin-top: 0.5rem;

  a { color: var(--accent-primary, var(--primary, #3b82f6)); }
}

.btn-lg {
  padding: 0.75rem 2rem;
  font-size: 1rem;
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

.meter-indeterminate {
  width: 30%;
  animation: indeterminate 1.5s ease-in-out infinite;
}

@keyframes indeterminate {
  0%   { margin-left: 0;   width: 30%; }
  50%  { margin-left: 40%; width: 30%; }
  100% { margin-left: 0;   width: 30%; }
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

.waveform-canvas {
  width: 100%;
  height: 64px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.15);
  margin-top: 0.5rem;
}

.test-recording-section {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-default, var(--input-border));
}

.test-recording-header {
  margin-bottom: 0.75rem;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--fs-body);
  cursor: pointer;

  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }
}

.btn-active-red {
  background: #ef4444 !important;
  color: #fff !important;
}

.recording-timer {
  font-size: var(--fs-body);
  color: #ef4444;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.playback-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.playback-label {
  font-size: var(--fs-body-sm, 0.75rem);
  font-weight: 500;
  min-width: 100px;
  color: var(--text-secondary, #6b7280);
}

.playback-audio {
  flex: 1;
  height: 36px;
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

// ── Whisper model list ──

.model-list {
  margin-bottom: 1rem;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  margin-bottom: 0.5rem;

  &.model-active {
    border-color: var(--accent, #3b82f6);
    background: rgba(59, 130, 246, 0.05);
  }
}

.model-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.model-name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.model-meta {
  font-size: var(--fs-body-sm, 0.75rem);
  color: var(--text-secondary, #6b7280);
}

.badge-primary {
  background: var(--accent, #3b82f6);
  color: #fff;
}

.model-name {
  font-weight: 500;
  font-size: var(--fs-body);
}

.model-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn-small {
  font-size: var(--fs-body-sm);
  padding: 0.2rem 0.5rem;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 4px;

  &:hover {
    background: var(--bg-surface-hover, var(--nav-active));
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.btn-danger-text {
  color: var(--status-error, #ef4444);
}

.btn-primary {
  background: var(--accent-primary, var(--primary, #3b82f6)) !important;
  color: #fff !important;
  border-color: var(--accent-primary, var(--primary, #3b82f6)) !important;
}

.btn-danger {
  background: var(--status-error, #ef4444) !important;
  color: #fff !important;
  border-color: var(--status-error, #ef4444) !important;
}

.status-value {
  font-size: var(--fs-body);
  color: var(--text-primary, var(--body-text));
  font-variant-numeric: tabular-nums;
}

.status-path {
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: var(--fs-body-sm);
  color: var(--text-muted, var(--muted));
  word-break: break-all;
}

// ── Whisper activity/progress ──

.whisper-activity {
  padding: 1rem;
  border: 1px solid var(--accent-primary, var(--primary, #3b82f6));
  border-radius: 8px;
  background: var(--bg-surface, var(--card-bg, transparent));
}

.whisper-activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.whisper-activity-title {
  font-weight: 600;
  font-size: var(--fs-body);
}

.whisper-activity-pct {
  font-size: var(--fs-body);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--accent-primary, var(--primary, #3b82f6));
}

.whisper-log {
  margin-top: 0.5rem;
  max-height: 150px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted, var(--muted));
  background: var(--bg-page, var(--body-bg));
  border-radius: 4px;
  padding: 0.5rem;
}

.whisper-log-line {
  white-space: pre-wrap;
  word-break: break-all;
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
