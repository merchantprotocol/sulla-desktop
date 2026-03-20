<template>
  <form
    :class="formClass"
    :data-empty="!queryValue.trim()"
    :data-running="loading"
    @submit.prevent
  >
    <div
      class="relative overflow-visible rounded-lg bg-surface shadow-sm ring-1 ring-edge transition-shadow focus-within:ring-edge-strong"
      :class="panelClass"
    >
      <div class="absolute -top-px right-11 left-20 h-[2px] bg-linear-to-r from-sky-300/0 via-sky-300/70 to-sky-300/0" />
      <div class="absolute right-20 -bottom-px left-11 h-[2px] bg-linear-to-r from-blue-400/0 via-blue-400 to-blue-400/0" />
      <div class="flex flex-wrap items-end gap-1 p-2">
        <textarea
          ref="composerTextareaEl"
          v-model="queryValue"
          name="input"
          placeholder="Let's accomplish your goals together..."
          class="my-2 h-6 max-h-[400px] min-w-0 flex-1 resize-none bg-transparent text-content text-base leading-6 outline-none placeholder:text-content-muted"
          style="padding-left: 10px"
          :class="isComposerMultiline ? 'basis-full order-2' : 'order-2'"
          @input="updateComposerLayout"
          @keydown.enter.exact.prevent="emit('send')"
        />

        <div
          class="mb-0.5 flex items-center gap-2"
          :class="isComposerMultiline ? 'order-3 w-full justify-between' : 'order-3'"
        >
          <div
            :ref="modelSelector.modelMenuEl"
            class="relative mb-0.5"
          >
            <button
              :ref="modelSelector.buttonRef"
              type="button"
              class="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-content-muted hover:text-content-secondary hover:bg-surface-hover disabled:opacity-60"
              aria-label="Model select"
              :disabled="showOverlay"
              @click="handleModelSwitcherClick"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="shrink-0"
aria-hidden="true"
              >
                <path d="M12 8V4" />
                <path d="M8 4h8" />
                <rect
                  x="6"
                  y="8"
                  width="12"
                  height="10"
                  rx="2"
                />
                <path d="M9 18v2" />
                <path d="M15 18v2" />
                <path d="M9.5 12h.01" />
                <path d="M14.5 12h.01" />
                <path d="M10 15h4" />
              </svg>
              <div class="flex items-center gap-0.5 overflow-hidden">
                <span class="whitespace-nowrap font-medium text-xs">{{ modelSelector.activeModelLabelValue }}</span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 15 15"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  class="shrink-0"
                  aria-hidden="true"
                >
                  <path
                    d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                    fill="currentColor"
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                  />
                </svg>
              </div>
            </button>

            <div
              v-if="modelSelector.showModelMenuValue"
              class="agent-model-selector-menu absolute bottom-12 right-0 z-[9999] w-80 max-h-96 overflow-y-auto overflow-x-hidden rounded-2xl border border-edge bg-page shadow-xl"
            >
              <div class="flex items-center justify-between px-3 py-2 sticky top-0 bg-page z-10">
                <div class="text-xs font-semibold tracking-wide text-content-secondary">
                  Models
                </div>
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-hover hover:text-content"
                  aria-label="Close model selector"
                  @click="modelSelector.hideModelMenu"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 15 15"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    class="shrink-0"
                  >
                    <path
                      d="M11.7816 4.03157C12.0724 3.74081 12.0724 3.25991 11.7816 2.96915C11.4909 2.67839 11.0099 2.67839 10.7192 2.96915L7.50005 6.18827L4.28091 2.96915C3.99015 2.67839 3.50925 2.67839 3.21849 2.96915C2.92773 3.25991 2.92773 3.74081 3.21849 4.03157L6.43761 7.25071L3.21849 10.4698C2.92773 10.7606 2.92773 11.2415 3.21849 11.5323C3.50925 11.823 3.99015 11.823 4.28091 11.5323L7.50005 8.31315L10.7192 11.5323C11.0099 11.823 11.4909 11.823 11.7816 11.5323C12.0724 11.2415 12.0724 10.7606 11.7816 10.4698L8.56248 7.25071L11.7816 4.03157Z"
                      fill="currentColor"
                      fill-rule="evenodd"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </div>

              <div
                v-if="modelSelector.loadingProvidersValue"
                class="px-3 py-2 text-sm text-content-secondary"
              >
                Loading providers...
              </div>

              <div
                v-if="modelSelector.providerGroupsValue.length === 0 && !modelSelector.loadingProvidersValue"
                class="px-3 py-2 text-sm text-content-secondary"
              >
                No providers connected
              </div>

              <template
                v-for="(group, gIdx) in modelSelector.providerGroupsValue"
                :key="group.providerId"
              >
                <div
                  v-if="gIdx > 0"
                  class="border-t border-edge"
                />

                <div class="flex items-center gap-2 px-3 py-2">
                  <div class="text-xs font-semibold tracking-wide text-content-secondary">
                    {{ group.providerName }}
                  </div>
                  <span
                    v-if="group.isActiveProvider"
                    class="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-400"
                  >Primary</span>
                </div>

                <div
                  v-if="group.loading"
                  class="px-3 py-1.5 text-xs text-content-muted"
                >
                  Loading models...
                </div>

                <button
                  v-for="m in group.models"
                  :key="`${group.providerId}-${m.modelId}`"
                  type="button"
                  class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-content hover:bg-surface-hover"
                  @click="modelSelector.selectModel(m)"
                >
                  <span class="min-w-0 flex-1 truncate">{{ m.modelLabel }}</span>
                  <span
                    v-if="m.isActiveModel"
                    class="shrink-0 text-xs font-semibold text-content-secondary"
                  >Active</span>
                </button>
              </template>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              v-if="queryValue.trim()"
              type="button"
              class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-content text-page disabled:opacity-60 disabled:cursor-not-allowed hover:cursor-pointer"
              aria-label="Send"
              :disabled="showOverlay"
              @click="emit('send')"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 15 15"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z"
                  fill="currentColor"
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                />
              </svg>
            </button>

            <button
              v-if="hasMessages && graphRunning"
              type="button"
              class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-600 text-white disabled:opacity-60 disabled:cursor-not-allowed hover:cursor-pointer dark:bg-red-500 dark:text-white"
              aria-label="Stop"
              :disabled="showOverlay"
              @click="emit('stop')"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <rect
                  x="7"
                  y="7"
                  width="10"
                  height="10"
                  rx="2"
                  fill="currentColor"
                />
              </svg>
            </button>

            <!-- Voice mode: indicator + stop button pinned together -->
            <div
              v-if="isRecording && !queryValue.trim() && !graphRunning"
              class="mb-0.5 ml-auto flex items-center gap-2"
            >
              <div class="flex items-center gap-1.5 rounded-full bg-red-600/10 px-2.5 py-1 text-xs font-medium text-red-500">
                <span class="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                <!-- Audio level meter -->
                <div class="flex items-end gap-px h-3">
                  <div
                    v-for="i in 5"
                    :key="i"
                    class="w-0.5 rounded-full transition-all duration-75"
                    :class="audioLevel >= i * 20 ? 'bg-red-500' : 'bg-red-500/20'"
                    :style="{ height: `${ 4 + i * 2 }px` }"
                  />
                </div>
                <span>{{ recordingDuration }}</span>
              </div>
              <button
                type="button"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-600 text-white animate-pulse hover:cursor-pointer transition-colors"
                aria-label="Stop recording (Ctrl+Shift+V)"
                title="Stop recording (Ctrl+Shift+V)"
                @click="toggleRecording"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
              </button>
            </div>

            <button
              v-if="!isRecording && !queryValue.trim() && !graphRunning"
              type="button"
              class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-content text-page disabled:opacity-60 disabled:cursor-not-allowed hover:cursor-pointer transition-colors"
              aria-label="Voice (Ctrl+Shift+V)"
              title="Start voice mode (Ctrl+Shift+V)"
              :disabled="showOverlay"
              @click="toggleRecording"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19v3" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <rect
                  x="9"
                  y="2"
                  width="6"
                  height="13"
                  rx="3"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { AgentModelSelectorController } from './AgentModelSelectorController';

const props = withDefaults(defineProps<{
  modelValue:      string;
  loading:         boolean;
  showOverlay:     boolean;
  hasMessages:     boolean;
  graphRunning:    boolean;
  modelSelector:   AgentModelSelectorController;
  formClass?:      string;
  panelClass?:     string;
  autoStartVoice?: boolean;
}>(), {
  formClass:       'group/composer mx-auto mb-3 w-full',
  panelClass:      '',
  autoStartVoice:  false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send:                [];
  stop:                [];
  primaryAction:       [];
  'voice-interim':     [text: string];
  'voice-transcribed': [text: string];
  'voice-error':       [message: string];
}>();

const composerTextareaEl = ref<HTMLTextAreaElement | null>(null);
const isComposerMultiline = ref(false);
const isRecording = ref(false);
const audioLevel = ref(0); // 0-100, used for level meter visualization
const recordingDuration = ref('0:00');
let recordingStartTime = 0;
let recordingTimer: ReturnType<typeof setInterval> | null = null;

function startRecordingTimer(): void {
  recordingStartTime = Date.now();
  recordingDuration.value = '0:00';
  recordingTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    recordingDuration.value = `${ mins }:${ secs.toString().padStart(2, '0') }`;
  }, 1000);
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  recordingDuration.value = '0:00';
}

// ─── Voice Mode ──────────────────────────────────────────────
// Two transcription modes:
//   'browser'    — Web Speech API: free, real-time interim results shown as you speak
//   'elevenlabs' — ElevenLabs batch: higher accuracy, transcribes after silence
//
// Both modes keep the mic open (continuous). VAD detects silence → submit text → new segment.

let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let activeMimeType = 'audio/webm';
let transcriptionMode = 'browser'; // loaded from settings on first use
let sttLanguage = 'en-US';         // loaded from settings on first use

// SpeechRecognition (browser mode)
let recognition: any = null;
let recognitionText = '';            // accumulated final results for current segment
let recognitionInterim = '';         // current interim (partial) result
let voiceStopping = false;           // guard: prevents onend/onerror from restarting after stop

// VAD state (used for ElevenLabs mode; browser mode uses SpeechRecognition's own end detection)
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let VAD_SILENCE_THRESHOLD = 12;
let VAD_SILENCE_DURATION = 800;
const VAD_INITIAL_GRACE = 400;
let audioInputDeviceId = '';         // loaded from settings; '' = system default

// Audio level monitor (independent of VAD, runs in both browser and ElevenLabs modes)
let levelContext: AudioContext | null = null;
let levelAnalyser: AnalyserNode | null = null;
let levelInterval: ReturnType<typeof setInterval> | null = null;

function startAudioLevelMonitor(): void {
  if (!mediaStream) return;
  try {
    levelContext = new AudioContext();
    const src = levelContext.createMediaStreamSource(mediaStream);
    levelAnalyser = levelContext.createAnalyser();
    levelAnalyser.fftSize = 256;
    src.connect(levelAnalyser);
    const buf = new Uint8Array(levelAnalyser.fftSize);
    levelInterval = setInterval(() => {
      if (!levelAnalyser || !isRecording.value) return;
      levelAnalyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = (buf[i] - 128) / 128;
        sum += s * s;
      }
      audioLevel.value = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 300));
    }, 50);
  } catch { /* ignore */ }
}

function stopAudioLevelMonitor(): void {
  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }
  if (levelContext) {
    levelContext.close().catch(() => {});
    levelContext = null;
  }
  levelAnalyser = null;
  audioLevel.value = 0;
}
let silenceStart: number | null = null;
let segmentStart = 0;
let hasSpeechInSegment = false;

async function toggleRecording(): Promise<void> {
  if (isRecording.value) {
    await endVoiceMode();
  } else {
    await startVoiceMode();
  }
}

async function startVoiceMode(): Promise<void> {
  try {
    // Load transcription mode and VAD settings
    transcriptionMode = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionMode', 'browser');
    VAD_SILENCE_THRESHOLD = await ipcRenderer.invoke('sulla-settings-get', 'audioVadSilenceThreshold', 12);
    VAD_SILENCE_DURATION = await ipcRenderer.invoke('sulla-settings-get', 'audioVadSilenceDuration', 800);
    sttLanguage = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
    audioInputDeviceId = await ipcRenderer.invoke('sulla-settings-get', 'audioInputDeviceId', '');

    const audioConstraints: boolean | MediaTrackConstraints = audioInputDeviceId
      ? { deviceId: { exact: audioInputDeviceId } }
      : true;

    const getMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
      || ((constraints: MediaStreamConstraints) => new Promise<MediaStream>((resolve, reject) => {
        const legacy = (navigator as any).getUserMedia
          || (navigator as any).webkitGetUserMedia
          || (navigator as any).mozGetUserMedia;
        if (!legacy) {
          reject(new Error('getUserMedia is not supported in this environment'));

          return;
        }
        legacy.call(navigator, constraints, resolve, reject);
      }));

    mediaStream = await getMedia({ audio: audioConstraints });
    activeMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    isRecording.value = true;
    startRecordingTimer();
    startAudioLevelMonitor();
    voiceStopping = false;

    if (transcriptionMode === 'browser') {
      startBrowserRecognition();
    } else {
      emit('voice-interim', 'Listening...');
      startElevenLabsSegment();
      startVAD();
    }
  } catch (err) {
    console.error('[AgentComposer] Microphone access denied or unavailable:', err);
    emit('voice-error', 'Microphone access denied or unavailable');
    cleanupStream();
  }
}

// ── Browser mode (SpeechRecognition) ───────────────────────────

function startBrowserRecognition(): void {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[AgentComposer] SpeechRecognition not available, falling back to ElevenLabs');
    transcriptionMode = 'elevenlabs';
    startElevenLabsSegment();
    startVAD();

    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = sttLanguage;
  recognitionText = '';
  recognitionInterim = '';

  recognition.onresult = (event: any) => {
    let interim = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }

    if (finalText) {
      recognitionText += finalText;
    }
    recognitionInterim = interim;

    // Emit interim updates so the chat shows live transcription
    const displayText = (recognitionText + ' ' + recognitionInterim).trim();
    if (displayText) {
      emit('voice-interim', displayText);
    }
  };

  recognition.onend = () => {
    // If user hit stop, do NOT restart — exit immediately
    if (voiceStopping || !isRecording.value) return;

    const text = recognitionText.trim();
    if (text) {
      emit('voice-transcribed', text);
    }
    recognitionText = '';
    recognitionInterim = '';

    // Restart recognition for the next utterance
    try {
      recognition?.start();
    } catch { /* already started */ }
  };

  recognition.onerror = (event: any) => {
    console.warn('[AgentComposer] SpeechRecognition error:', event.error);

    // If user hit stop, ignore all errors
    if (voiceStopping || !isRecording.value) return;

    if (event.error === 'no-speech') {
      // No speech detected — restart
      try {
        recognition?.start();
      } catch { /* already started */ }
    } else if (event.error === 'network' || event.error === 'service-not-allowed' || event.error === 'not-allowed') {
      // Browser speech services unavailable — fall back to ElevenLabs mode
      console.warn('[AgentComposer] Browser speech unavailable, switching to ElevenLabs mode');
      try { recognition?.stop(); } catch { /* ignore */ }
      recognition = null;
      recognitionText = '';
      recognitionInterim = '';
      transcriptionMode = 'elevenlabs';

      if (mediaStream) {
        emit('voice-interim', 'Listening...');
        startElevenLabsSegment();
        startVAD();
      }
    } else if (event.error === 'aborted') {
      // Intentional abort — do nothing
    } else {
      // Other errors — try to restart
      try {
        recognition?.start();
      } catch { /* already started */ }
    }
  };

  recognition.start();
}

// ── ElevenLabs mode (batch with VAD) ───────────────────────────

function startElevenLabsSegment(): void {
  if (!mediaStream) return;

  audioChunks = [];
  hasSpeechInSegment = false;
  segmentStart = Date.now();
  silenceStart = null;

  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: activeMimeType });

  mediaRecorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const audioBlob = new Blob(audioChunks, { type: activeMimeType });
    audioChunks = [];

    if (audioBlob.size > 0 && hasSpeechInSegment) {
      // Transcribe via ElevenLabs batch API and emit
      transcribeAndEmit(audioBlob, activeMimeType);
    }
  };

  mediaRecorder.start();
}

async function transcribeAndEmit(audioBlob: Blob, mimeType: string): Promise<void> {
  emit('voice-interim', 'Transcribing...');

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const result = await ipcRenderer.invoke('audio-transcribe', { audio: arrayBuffer, mimeType });

    if (result?.text?.trim()) {
      emit('voice-transcribed', result.text.trim());
    }
  } catch (err) {
    console.error('[AgentComposer] ElevenLabs transcription failed:', err);
    emit('voice-error', 'Transcription failed — check your ElevenLabs API key');
  }

  // Start a new segment if still in voice mode
  if (isRecording.value && mediaStream) {
    emit('voice-interim', 'Listening...');
    startElevenLabsSegment();
  }
}

function flushElevenLabsSegment(): void {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  console.log('[AgentComposer] VAD: pause detected, flushing ElevenLabs segment');
  mediaRecorder.stop(); // triggers onstop → transcribeAndEmit
}

function startVAD(): void {
  if (!mediaStream) return;

  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);

    vadInterval = setInterval(() => {
      if (!analyser || !isRecording.value) return;

      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const sample = (dataArray[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / dataArray.length) * 100;

      // Update audio level for visualization (clamp 0-100)
      audioLevel.value = Math.min(100, Math.round(rms * 3));

      const now = Date.now();
      const elapsed = now - segmentStart;

      if (rms >= VAD_SILENCE_THRESHOLD) {
        silenceStart = null;
        hasSpeechInSegment = true;
      } else if (hasSpeechInSegment) {
        if (silenceStart === null) {
          silenceStart = now;
        } else if (elapsed > VAD_INITIAL_GRACE && (now - silenceStart) >= VAD_SILENCE_DURATION) {
          flushElevenLabsSegment();
        }
      }
    }, 100);
  } catch (err) {
    console.warn('[AgentComposer] VAD setup failed:', err);
  }
}

// ── Shared teardown ────────────────────────────────────────────

async function endVoiceMode(): Promise<void> {
  // Set the stopping flag FIRST so onend/onerror handlers won't restart
  voiceStopping = true;
  isRecording.value = false;
  stopRecordingTimer();
  stopAudioLevelMonitor();

  // Browser mode: stop recognition, submit any remaining text
  if (recognition) {
    const text = recognitionText.trim();
    try { recognition.abort(); } catch { /* ignore */ }
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
    if (text) {
      emit('voice-transcribed', text);
    }
    // Clear interim display
    emit('voice-interim', '');
    recognitionText = '';
    recognitionInterim = '';
  }

  // ElevenLabs mode: flush last segment
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // triggers onstop → transcribeAndEmit if hasSpeechInSegment
  }

  stopVAD();
  cleanupStream();
  voiceStopping = false;
}

function stopVAD(): void {
  if (vadInterval) {
    clearInterval(vadInterval);
    vadInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyser = null;
  silenceStart = null;
}

function stopRecording(): void {
  endVoiceMode();
}

function cleanupStream(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  audioChunks = [];
}

let composerMirrorEl: HTMLDivElement | null = null;
let composerMeasureCanvas: HTMLCanvasElement | null = null;

const queryValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
});

function getComposerMirrorEl(): HTMLDivElement {
  if (composerMirrorEl) {
    return composerMirrorEl;
  }

  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = '-99999px';
  el.style.top = '0';
  el.style.visibility = 'hidden';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
  el.style.overflowWrap = 'break-word';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);
  composerMirrorEl = el;

  return el;
}

function updateComposerLayout(): void {
  const el = composerTextareaEl.value;
  if (!el) {
    return;
  }

  const style = window.getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight || '24');
  const paddingTop = Number.parseFloat(style.paddingTop || '0');
  const paddingBottom = Number.parseFloat(style.paddingBottom || '0');
  const singleLineHeight = Math.ceil(lineHeight + paddingTop + paddingBottom);

  if (!composerMeasureCanvas) {
    composerMeasureCanvas = document.createElement('canvas');
  }
  const ctx = composerMeasureCanvas.getContext('2d');
  const font = style.font ? style.font : `${ style.fontWeight } ${ style.fontSize } ${ style.fontFamily }`;
  if (ctx) {
    ctx.font = font;
  }

  const mirror = getComposerMirrorEl();
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.textTransform = style.textTransform;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.width = `${ el.clientWidth }px`;

  mirror.textContent = `${ el.value || '' }\n`;
  const measuredHeight = mirror.scrollHeight;

  const typed = el.value || '';
  const typedWidthPx = ctx ? ctx.measureText(typed).width : 0;
  const earlyMultiline = typedWidthPx > (el.clientWidth * 0.5);

  const multiline = measuredHeight > (singleLineHeight + 1) || typed.includes('\n') || earlyMultiline;
  isComposerMultiline.value = multiline;

  const maxPx = 400;
  if (!multiline) {
    el.style.height = `${ singleLineHeight }px`;
    return;
  }

  el.style.height = 'auto';
  const minMultilineHeight = Math.ceil(singleLineHeight * 2);
  const nextHeight = Math.min(Math.max(el.scrollHeight, minMultilineHeight), maxPx);
  el.style.height = `${ nextHeight }px`;
}

const handleModelSwitcherClick = (): void => {
  void props.modelSelector.toggleModelMenu();
};

watch(() => props.modelValue, async() => {
  await nextTick();
  updateComposerLayout();
});

// Keyboard shortcut for voice mode toggle (Ctrl+Shift+V / Cmd+Shift+V)
function handleVoiceShortcut(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
    e.preventDefault();
    toggleRecording();
  }
}

onMounted(async() => {
  await nextTick();
  updateComposerLayout();
  window.addEventListener('keydown', handleVoiceShortcut);

  // Auto-start voice mode if requested (e.g. when transitioning from intro to chat thread)
  if (props.autoStartVoice && !isRecording.value) {
    startVoiceMode();
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleVoiceShortcut);
  if (composerMirrorEl) {
    composerMirrorEl.remove();
    composerMirrorEl = null;
  }
  composerMeasureCanvas = null;
  stopRecordingTimer();
  stopAudioLevelMonitor();
  stopRecording();
  stopVAD();
  cleanupStream();
});
</script>
