// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke: vi.fn(() => Promise.resolve()) } }));

import { sanitizeIpcPayload } from '../../../services/IpcMessageBusRenderer';

describe('sanitizeIpcPayload', () => {
  it('unwraps nested reactive metadata and drops non-cloneable values without changing base64', () => {
    // risk: user messages with reactive attachment metadata fail structured cloning before IPC dispatch
    const metadata = reactive({
      attachment: { fileRef: reactive({ name: 'photo.png' }), source: { data: 'YWJj+/==' } },
      ignored: () => 'not cloneable',
    });
    const result = sanitizeIpcPayload(metadata);
    expect(result).toEqual({ attachment: { fileRef: { name: 'photo.png' }, source: { data: 'YWJj+/==' } } });
    expect(() => structuredClone(result)).not.toThrow();
  });
});
