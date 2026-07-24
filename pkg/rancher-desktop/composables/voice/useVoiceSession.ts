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

import { ref, readonly, watch, onUnmounted, type Ref } from 'vue';

import { TTSPlayerService } from './TTSPlayerService';
import { logBargeIn } from './VoiceLogger';

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

// Fallback commit delay (ms). The PRIMARY end-of-turn trigger is the main-process
// `utterance_end` event (VAD silence + drained pipeline); this timer only fires if
// that signal never arrives (e.g. VAD wedged open by background noise). It is
// deliberately long so it never pre-empts a real utterance mid-thought — the old
// 2000ms value collided with whisper's 2000ms chunk cadence and split utterances.
const UTTERANCE_FALLBACK_MS = 8000;

// How long the user must speak continuously before we treat it as a
// barge-in and cut TTS off. Short sounds (coughs, "mm-hm", chair squeaks
// the VAD flags as speech) should never kill Sulla mid-sentence.
const BARGE_IN_GRACE_MS = 400;

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

  // A turn that produces a text-only reply never fires playbackStart, so
  // THINKING would stick forever. Leave THINKING when the graph run ends
  // without any TTS playing.
  watch(chatController.graphRunning, (running) => {
    if (!running && pipelineState.value === 'THINKING' && !isTTSPlaying.value) {
      pipelineState.value = isRecording.value ? 'LISTENING' : 'IDLE';
    }
  });

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
    if (!isRecording.value) return;

    // End-of-turn: the main process detected the user finished speaking and the
    // transcription pipeline drained → commit the whole accumulated turn as ONE
    // message. This is the primary trigger; the fallback timer is just a safety net.
    if (msg?.event_type === 'utterance_end') {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      sendAccumulatedTranscript();
      return;
    }

    if (!msg?.text) return;

    // Don't transcribe Sulla's own TTS back into the next user message. The mic stays
    // open while she speaks; barge-in (below) stops TTS, after which transcripts flow.
    if (isTTSPlaying.value) return;

    const text = msg.text.trim();
    if (!text) return;

    const isPartial = msg.event_type === 'transcript_partial';

    console.log('[VoiceSession] Transcript received:', { text: text.substring(0, 60), partial: isPartial });

    if (isPartial) {
      // Show partial in the interim message
      updateInterimMessage(accumulatedTranscript + (accumulatedTranscript ? ' ' : '') + text);
    } else {
      // Final transcript chunk — accumulate; commit happens on `utterance_end`.
      accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + text;
      updateInterimMessage(accumulatedTranscript);
      lastTranscriptTime = Date.now();

      // Arm the long fallback timer only (in case utterance_end never arrives).
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        sendAccumulatedTranscript();
      }, UTTERANCE_FALLBACK_MS);
    }
  };

  // ── VAD event handler (audio level meter + barge-in) ──

  // Timestamp of the first VAD "speaking" frame while TTS was playing;
  // 0 when the user is not speaking over Sulla.
  let bargeInSpeechStart = 0;

  const onMicVad = (_event: any, data: { speaking: boolean; level: number }) => {
    if (!isRecording.value) return;
    audioLevel.value = Math.round(Math.min(100, data.level * 100));

    // Barge-in: sustained user speech while Sulla is speaking stops TTS.
    // The grace period keeps brief noises from interrupting playback.
    if (data.speaking && isTTSPlaying.value) {
      if (bargeInSpeechStart === 0) {
        bargeInSpeechStart = Date.now();
      } else if (Date.now() - bargeInSpeechStart >= BARGE_IN_GRACE_MS) {
        logBargeIn();
        ttsPlayer.stop();
        bargeInSpeechStart = 0;
      }
    } else {
      bargeInSpeechStart = 0;
    }
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
