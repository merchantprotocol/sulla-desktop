/**
 * useVoiceSession — Vue composable for voice chat with Sula.
 *
 * Uses the audio-driver's VAD (broadcast from tray panel) to control
 * browser SpeechRecognition. The audio-driver's sophisticated VAD
 * (ZCR, pitch, spectral, fan noise) decides WHEN speech is happening.
 * Browser SpeechRecognition handles the actual speech-to-text.
 *
 * Flow:
 *   1. User clicks mic → enters voice mode
 *   2. audio-driver:mic-vad events arrive with { speaking, level, fanNoise }
 *   3. speaking=true  → start SpeechRecognition (if not already running)
 *   4. speaking=false → after debounce, stop SpeechRecognition, send transcript
 *   5. User clicks mic again → exit voice mode
 *
 * TTS playback via TTSPlayerService is preserved unchanged.
 *
 * Called once per BrowserTabChat instance.
 */

import { ref, readonly, onUnmounted, type Ref } from 'vue';
import { ipcRenderer as _ipcRenderer } from '@pkg/utils/ipcRenderer';

const ipcRenderer = _ipcRenderer as any;
import type { ChatInterface, ChatMessage } from '../../pages/agent/ChatInterface';
import { TTSPlayerService } from './TTSPlayerService';

// ─── Types ──────────────────────────────────────────────────────

export type VoiceMode = 'voice' | 'secretary' | 'intake';
export type PipelineState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface UseVoiceSessionOptions {
  chatController: ChatInterface;
  messages: Ref<ChatMessage[]>;
  onError?: (message: string) => void;
}

export interface UseVoiceSessionReturn {
  // Reactive state for template binding
  isRecording: Readonly<Ref<boolean>>;
  audioLevel: Readonly<Ref<number>>;
  recordingDuration: Readonly<Ref<string>>;
  isTTSPlaying: Readonly<Ref<boolean>>;
  pipelineState: Readonly<Ref<PipelineState>>;
  voiceMode: Ref<VoiceMode>;

  // Actions
  toggleRecording(): Promise<void>;
  stopTTS(): void;

  // Cleanup
  dispose(): void;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// How long silence must persist before we finalize and send (ms)
const SILENCE_SEND_DELAY = 1500;

// ─── Composable ─────────────────────────────────────────────────

export function useVoiceSession(options: UseVoiceSessionOptions): UseVoiceSessionReturn {
  const { chatController, onError: _onError } = options;

  // ── Reactive state ──
  const isRecording = ref(false);
  const audioLevel = ref(0);
  const recordingDuration = ref('0:00');
  const isTTSPlaying = ref(false);
  const pipelineState = ref<PipelineState>('IDLE');
  const voiceMode = ref<VoiceMode>('voice');

  // ── TTS service (preserved from original) ──
  const ttsPlayer = new TTSPlayerService({
    ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
  });

  const unsubs: Array<() => void> = [];

  unsubs.push(
    ttsPlayer.on('playbackStart', () => {
      isTTSPlaying.value = true;
      pipelineState.value = 'SPEAKING';
    }),
    ttsPlayer.on('queueEmpty', () => {
      isTTSPlaying.value = false;
      if (pipelineState.value === 'SPEAKING') {
        pipelineState.value = isRecording.value ? 'LISTENING' : 'IDLE';
      }
    }),
  );

  // ── Listen for speak events from the agent ──
  unsubs.push(
    chatController.onSpeakDispatch((text, _threadId, _pipelineSequence) => {
      if (text.trim()) {
        ttsPlayer.enqueue(text.trim(), `speak_${Date.now()}`);
        if (pipelineState.value === 'THINKING') {
          pipelineState.value = 'SPEAKING';
        }
      }
    }),
  );

  // ── SpeechRecognition state ──
  let recognition: SpeechRecognition | null = null;
  let recognitionRunning = false;
  let interimMessageId: string | null = null;
  let accumulatedTranscript = '';

  // ── Silence debounce ──
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Recording duration timer ──
  let durationSeconds = 0;
  let durationInterval: ReturnType<typeof setInterval> | null = null;

  function startDurationTimer() {
    durationSeconds = 0;
    recordingDuration.value = '0:00';
    durationInterval = setInterval(() => {
      durationSeconds++;
      recordingDuration.value = formatDuration(durationSeconds);
    }, 1000);
  }

  function stopDurationTimer() {
    if (durationInterval !== null) {
      clearInterval(durationInterval);
      durationInterval = null;
    }
    durationSeconds = 0;
    recordingDuration.value = '0:00';
  }

  // ── Interim message helpers ──
  function updateInterimMessage(text: string) {
    const messages = chatController.messages.value;
    const existing = messages.find(m => m.id === interimMessageId);
    if (existing) {
      existing.content = text;
    } else {
      interimMessageId = `voice-interim-${Date.now()}`;
      messages.push({
        id:        interimMessageId,
        channelId: '',
        role:      'user',
        content:   text,
        kind:      'voice_interim',
      });
    }
  }

  function removeInterimMessage() {
    if (!interimMessageId) return;
    const messages = chatController.messages.value;
    const idx = messages.findIndex(m => m.id === interimMessageId);
    if (idx !== -1) messages.splice(idx, 1);
    interimMessageId = null;
  }

  // ── SpeechRecognition lifecycle ──

  function createRecognition(): SpeechRecognition | null {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      _onError?.('SpeechRecognition is not supported in this browser.');
      return null;
    }

    const rec = new SR() as SpeechRecognition;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      if (finalText.trim()) {
        accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + finalText.trim();
        updateInterimMessage(accumulatedTranscript);
      } else if (interimText.trim()) {
        updateInterimMessage(accumulatedTranscript + (accumulatedTranscript ? ' ' : '') + interimText.trim());
      }
    };

    rec.onend = () => {
      recognitionRunning = false;
      // Don't auto-restart — VAD controls the lifecycle
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('[useVoiceSession] SpeechRecognition error:', event.error);
      recognitionRunning = false;

      if (event.error === 'not-allowed') {
        _onError?.('Microphone access denied.');
        stopRecording();
      }
    };

    return rec;
  }

  function startSpeechRecognition() {
    if (recognitionRunning) return;
    if (!recognition) {
      recognition = createRecognition();
      if (!recognition) return;
    }
    try {
      recognition.start();
      recognitionRunning = true;
    } catch {
      // Already started — ignore
    }
  }

  function stopSpeechRecognition() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // Already stopped
    }
    recognitionRunning = false;
  }

  function sendAccumulatedTranscript() {
    const text = accumulatedTranscript.trim();
    accumulatedTranscript = '';
    removeInterimMessage();

    if (text) {
      chatController.query.value = text;
      chatController.send({ inputSource: 'voice' });
    }
  }

  // ── VAD event handler ──

  const onMicVad = (_event: any, data: { speaking: boolean; level: number; fanNoise: boolean }) => {
    if (!isRecording.value) return;

    // Update audio level for the meter (scale 0-1 RMS to 0-100 for UI)
    audioLevel.value = Math.round(Math.min(100, data.level * 100));

    if (data.speaking) {
      // Clear any pending silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      // Start recognition when VAD detects speech
      startSpeechRecognition();
    } else {
      // VAD says silence — start debounce timer to finalize
      if (recognitionRunning && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          silenceTimer = null;
          stopSpeechRecognition();
          sendAccumulatedTranscript();
        }, SILENCE_SEND_DELAY);
      }
    }
  };

  // ── Actions ──

  async function startRecording() {
    isRecording.value = true;
    pipelineState.value = 'LISTENING';
    accumulatedTranscript = '';
    startDurationTimer();

    // Start mic via MicrophoneDriverController (ref-counted)
    await ipcRenderer.invoke('audio-driver:start-mic', 'voice-chat');

    // Listen for VAD data (sent only to holder windows)
    ipcRenderer.on('audio-driver:mic-vad', onMicVad);
  }

  function stopRecording() {
    isRecording.value = false;
    ipcRenderer.removeListener('audio-driver:mic-vad', onMicVad);

    // Clear silence timer
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    // Stop recognition and send any remaining transcript
    stopSpeechRecognition();
    if (accumulatedTranscript.trim()) {
      sendAccumulatedTranscript();
    }

    // Clean up recognition instance
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition = null;
    }

    removeInterimMessage();
    stopDurationTimer();
    audioLevel.value = 0;

    // Release mic via MicrophoneDriverController (ref-counted)
    ipcRenderer.invoke('audio-driver:stop-mic', 'voice-chat').catch(() => {});

    if (pipelineState.value === 'LISTENING') {
      pipelineState.value = 'IDLE';
    }
  }

  async function toggleRecording(): Promise<void> {
    if (isRecording.value) {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  function stopTTS(): void {
    ttsPlayer.stop();
  }

  // ── Cleanup ──
  function dispose(): void {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    stopRecording();
    ttsPlayer.dispose();
  }

  onUnmounted(dispose);

  return {
    isRecording:       readonly(isRecording),
    audioLevel:        readonly(audioLevel),
    recordingDuration: readonly(recordingDuration),
    isTTSPlaying:      readonly(isTTSPlaying),
    pipelineState:     readonly(pipelineState),
    voiceMode,
    toggleRecording,
    stopTTS,
    dispose,
  };
}
