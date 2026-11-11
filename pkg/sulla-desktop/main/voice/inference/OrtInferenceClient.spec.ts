// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { OrtInferenceClient } from './OrtInferenceClient';

describe('OrtInferenceClient', () => {
  it('rejects a request when a forked utility process never responds', async () => {
    const child = { postMessage: vi.fn(), on: vi.fn() };
    const log = vi.fn();
    const client = new OrtInferenceClient('/missing/voiceInferenceProcess.js', 15, 3, 1, () => child, log);
    // risk: user messages — an unresponsive ORT process must fail open through SpeechChunkGate, not hang warm-up forever.
    await expect(client.infer({ operation: 'vad-chunk', modelPath: '/model', audio: new Float32Array(576) })).rejects.toThrow('ONNX inference timed out');
    expect(log).toHaveBeenCalledWith('warn', 'ORT inference timed out', expect.objectContaining({ timeoutMs: 15 }));
  });
});
