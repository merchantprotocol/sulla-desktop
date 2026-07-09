/**
 * VoiceStateProvider — shares one tab's voice session state with any
 * descendant component (composer, empty-state landing, indicators)
 * without threading props through every level.
 *
 * The chat page that owns the useVoiceSession() instance calls
 * provideVoiceState(); descendants call useVoiceState(). Hosts without
 * a voice session (e.g. SidePanelChat) provide nothing — descendants
 * then get inert defaults: voice never configured, no-op actions.
 */

import { inject, provide, readonly, ref } from 'vue';

import type { PipelineState } from './useVoiceSession';
import type { InjectionKey, Ref } from 'vue';

export interface VoiceState {
  isRecording:       Readonly<Ref<boolean>>;
  audioLevel:        Readonly<Ref<number>>;
  recordingDuration: Readonly<Ref<string>>;
  isTTSPlaying:      Readonly<Ref<boolean>>;
  pipelineState:     Readonly<Ref<PipelineState>>;
  voiceConfigured:   Readonly<Ref<boolean>>;
  toggleRecording(): Promise<void> | void;
  stopTTS(): void;
}

const VoiceStateKey: InjectionKey<VoiceState> = Symbol('voice-state');

export function provideVoiceState(state: VoiceState): void {
  provide(VoiceStateKey, state);
}

export function useVoiceState(): VoiceState {
  return inject(VoiceStateKey, createInertVoiceState, true);
}

function createInertVoiceState(): VoiceState {
  return {
    isRecording:       readonly(ref(false)),
    audioLevel:        readonly(ref(0)),
    recordingDuration: readonly(ref('0:00')),
    isTTSPlaying:      readonly(ref(false)),
    pipelineState:     readonly(ref<PipelineState>('IDLE')),
    voiceConfigured:   readonly(ref(false)),
    toggleRecording:   () => {},
    stopTTS:           () => {},
  };
}
