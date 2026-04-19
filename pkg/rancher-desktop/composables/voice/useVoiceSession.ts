/**
 * useVoiceSession — Vue composable for voice chat with Sulla.
 *
 * Uses the MicrophoneDriverController's PCM pipeline + whisper.cpp for
 * local speech-to-text. The audio driver's VAD decides WHEN speech is
 * happening; whisper processes the raw PCM; transcript events arrive
 * on the gateway-transcript channel.
 *
 * Flow:
 *   1. User clicks mic → enters voice mode
 *   2. start-mic with pcm-s16le format → PCM flows to whisper
 *   3. start transcribe-start → whisper begins processing
 *   4. gateway-transcript events arrive with text
 *   5. Silence after speech → send accumulated transcript to chat
 *   6. User clicks mic again → exit voice mode
 *
 * TTS playback via TTSPlayerService is preserved unchanged.
 *
 * Called once per BrowserTabChat instance.
 */

import { ref, readonly, onUnmounted, type Ref } from 'vue';

import { TTSPlayerService } from './TTSPlayerService';

import { ipcRenderer as _ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ChatInterface, ChatMessage } from '../../pages/agent/ChatInterface';

const ipcRenderer = _ipcRenderer as any;

// ─── Types ──────────────────────────────────────────────────────

export type VoiceMode = 'voice' | 'secretary' | 'intake';
export type PipelineState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface UseVoiceSessionOptions {
  chatController: ChatInterface;
  messages:       Ref<ChatMessage[]>;
  onError?:       (message: string) => void;
}

export interface UseVoiceSessionReturn {
  // Reactive state for template binding
  isRecording:       Readonly<Ref<boolean>>;
  audioLevel:        Readonly<Ref<number>>;
  recordingDuration: Readonly<Ref<string>>;
  isTTSPlaying:      Readonly<Ref<boolean>>;
  pipelineState:     Readonly<Ref<PipelineState>>;
  voiceMode:         Ref<VoiceMode>;

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
  return `${ m }:${ s.toString().padStart(2, '0') }`;
}

// How long silence must persist before we finalize and send (ms)
const SILENCE_SEND_DELAY = 2000;

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

  // ── TTS service ──
  const ttsPlayer = new TTSPlayerService({
    ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
  });

  const unsubs: (() => void)[] = [];

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
        ttsPlayer.enqueue(text.trim(), `speak_${ Date.now() }`);
        if (pipelineState.value === 'THINKING') {
          pipelineState.value = 'SPEAKING';
        }
      }
    }),
  );

  // ── Transcript state ──
  let interimMessageId: string | null = null;
  let accumulatedTranscript = '';
  let lastTranscriptTime = 0;

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
      interimMessageId = `voice-interim-${ Date.now() }`;
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

  function sendAccumulatedTranscript() {
    const text = accumulatedTranscript.trim();
    accumulatedTranscript = '';
    removeInterimMessage();

    if (text) {
      console.log('[VoiceSession] Sending transcript to chat:', text.substring(0, 80));
      chatController.query.value = text;
      chatController.send({ inputSource: 'voice' });
      pipelineState.value = 'THINKING';
    }
  }

  // ── Whisper transcript handler ──

  const onTranscript = (_event: any, msg: any) => {
    if (!isRecording.value || !msg?.text) return;

    const text = msg.text.trim();
    if (!text) return;

    const isPartial = msg.event_type === 'transcript_partial';

    console.log('[VoiceSession] Transcript received:', { text: text.substring(0, 60), partial: isPartial });

    if (isPartial) {
      // Show partial in the interim message
      updateInterimMessage(accumulatedTranscript + (accumulatedTranscript ? ' ' : '') + text);
    } else {
      // Final transcript — accumulate
      accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + text;
      updateInterimMessage(accumulatedTranscript);
      lastTranscriptTime = Date.now();

      // Reset silence timer — wait for more speech
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        sendAccumulatedTranscript();
      }, SILENCE_SEND_DELAY);
    }
  };

  // ── VAD event handler (for audio level meter only) ──

  const onMicVad = (_event: any, data: { speaking: boolean; level: number }) => {
    if (!isRecording.value) return;
    audioLevel.value = Math.round(Math.min(100, data.level * 100));
  };

  // ── Actions ──

  async function startRecording() {
    console.log('[VoiceSession] startRecording — requesting mic + whisper');
    isRecording.value = true;
    pipelineState.value = 'LISTENING';
    accumulatedTranscript = '';
    lastTranscriptTime = 0;
    startDurationTimer();

    // Start mic with PCM format for whisper
    const micResult = await ipcRenderer.invoke('audio-driver:start-mic', 'voice-chat', ['pcm-s16le']);
    console.log('[VoiceSession] start-mic result:', micResult);

    // Start whisper transcription
    const whisperResult = await ipcRenderer.invoke('audio-driver:transcribe-start', {
      mode: 'conversation',
    });
    console.log('[VoiceSession] transcribe-start result:', whisperResult);

    if (!whisperResult?.ok) {
      _onError?.('Failed to start transcription. Check that whisper is installed with a model downloaded.');
      stopRecording();
      return;
    }

    // Listen for transcript events from whisper
    ipcRenderer.on('gateway-transcript', onTranscript);

    // Listen for VAD data (for audio level meter)
    ipcRenderer.on('audio-driver:mic-vad', onMicVad);

    console.log('[VoiceSession] Voice mode active — whisper pipeline running');
  }

  function stopRecording() {
    console.log('[VoiceSession] stopRecording');
    isRecording.value = false;

    ipcRenderer.removeListener('gateway-transcript', onTranscript);
    ipcRenderer.removeListener('audio-driver:mic-vad', onMicVad);

    // Clear silence timer
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    // Send any remaining transcript
    if (accumulatedTranscript.trim()) {
      sendAccumulatedTranscript();
    }

    removeInterimMessage();
    stopDurationTimer();
    audioLevel.value = 0;

    // Stop whisper transcription
    ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => {});

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
