// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Voice system — barrel exports
export { TypedEventEmitter } from './TypedEventEmitter';
export { TTSPlayerService, type TTSPlayerEvents, type TTSPlayerConfig } from './TTSPlayerService';
export { createVoiceBargeInDetector, DEFAULT_BARGE_IN_GRACE_MS, type VoiceBargeInDetector, type VoiceBargeInDetectorOptions } from './VoiceBargeInDetector';
export { createVoiceTurnAccumulator, type VoiceTurnAccumulator, type VoiceTurnAccumulatorConfig } from './VoiceTurnAccumulator';
export { useVoiceSession, type VoiceMode, type PipelineState, type UseVoiceSessionOptions, type UseVoiceSessionReturn } from './useVoiceSession';
export { provideVoiceState, useVoiceState, type VoiceState } from './voiceStateProvider';
export { setVoiceLogContext, vlog, type VoiceComponent } from './VoiceLogger';
