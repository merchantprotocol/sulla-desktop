// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import { RestartState } from '@pkg/main/restartState';

describe('RestartState', () => {
  it('keeps the first restart intent and permits exactly one completion', () => {
    const state = new RestartState();

    expect(state.beginCompletion()).toBe(false);
    expect(state.request('update')).toBe(true);
    expect(state.request('application')).toBe(false);
    expect(state.kind).toBe('update');
    expect(state.beginCompletion()).toBe(true);
    expect(state.beginCompletion()).toBe(false);
  });
});
