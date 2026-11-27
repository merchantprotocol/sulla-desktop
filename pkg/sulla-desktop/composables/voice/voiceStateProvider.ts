// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import { VoiceModeToggleController } from './VoiceModeToggleController';

import type { PipelineState } from './useVoiceSession';
import type { InjectionKey, Ref } from 'vue';

export interface VoiceState {
  isRecording:       Readonly<Ref<boolean>>;
  audioLevel:        Readonly<Ref<number>>;
  recordingDuration: Readonly<Ref<string>>;
  isTTSPlaying:      Readonly<Ref<boolean>>;
  pipelineState:     Readonly<Ref<PipelineState>>;
  voiceConfigured:   Readonly<Ref<boolean>>;
  toggleRecording(): Promise<void>;
  handleVoiceShortcut(event: KeyboardEvent): Promise<void> | undefined;
  stopTTS(): void;
}

const VoiceStateKey: InjectionKey<VoiceState> = Symbol('voice-state');

export function provideVoiceState(state: Omit<VoiceState, 'handleVoiceShortcut'>): void {
  const toggleController = new VoiceModeToggleController({
    isRecording:      () => state.isRecording.value,
    isEnabled:        () => state.voiceConfigured.value,
    toggleRecording:  () => state.toggleRecording(),
  });

  provide(VoiceStateKey, {
    ...state,
    toggleRecording:    () => toggleController.toggle(),
    handleVoiceShortcut: event => toggleController.handleShortcut(event),
  });
}

export function useVoiceState(): VoiceState {
  return inject(VoiceStateKey, createInertVoiceState, true);
}

function createInertVoiceState(): VoiceState {
  const toggleController = new VoiceModeToggleController({
    isRecording:      () => false,
    isEnabled:        () => false,
    toggleRecording:  () => {},
  });

  return {
    isRecording:       readonly(ref(false)),
    audioLevel:        readonly(ref(0)),
    recordingDuration: readonly(ref('0:00')),
    isTTSPlaying:      readonly(ref(false)),
    pipelineState:     readonly(ref<PipelineState>('IDLE')),
    voiceConfigured:   readonly(ref(false)),
    toggleRecording:   () => toggleController.toggle(),
    handleVoiceShortcut: event => toggleController.handleShortcut(event),
    stopTTS:           () => {},
  };
}
