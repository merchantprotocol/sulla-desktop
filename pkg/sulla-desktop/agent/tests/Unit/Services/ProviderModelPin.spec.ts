// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ProviderModelPin } from '@pkg/vault-broker/ProviderModelPin';

describe('a provider bridge pinned to a model', () => {
  // risk: choosing "opus" in AI models made every Claude Code request fail with provider_model_denied,
  // because the CLI sends the full id ("claude-opus-5-5") and the pin was the bare alias
  it('pinned to a Claude Code alias accepts that family', () => {
    expect(ProviderModelPin.allows('claude-opus-5-5', ['opus'])).toBe(true);
    expect(ProviderModelPin.allows('claude-opus-5-5[1m]', ['opus'])).toBe(true);
    expect(ProviderModelPin.allows('claude-sonnet-5-5', ['sonnet'])).toBe(true);
    expect(ProviderModelPin.allows('claude-haiku-5-5', ['haiku'])).toBe(true);
  });

  it('still refuses any other model, which is what the pin is for', () => {
    expect(ProviderModelPin.allows('claude-sonnet-5-5', ['opus'])).toBe(false);
    expect(ProviderModelPin.allows('claude-opus-5-5', ['claude-sonnet-5-5'])).toBe(false);
    expect(ProviderModelPin.allows('gpt-6.1-sol', ['opus'])).toBe(false);
    expect(ProviderModelPin.allows('xclaude-opus-5-5', ['opus'])).toBe(false);
    expect(ProviderModelPin.allows(undefined, ['opus'])).toBe(false);
  });

  it('a full id pin matches exactly, and no pin allows anything', () => {
    expect(ProviderModelPin.allows('claude-opus-5-5', ['claude-opus-5-5'])).toBe(true);
    expect(ProviderModelPin.allows('anything', undefined)).toBe(true);
    expect(ProviderModelPin.allows('anything', [])).toBe(true);
  });

  it('reads the model from a request body', () => {
    expect(ProviderModelPin.requested({ model: 'claude-opus-5-5', messages: [] })).toBe('claude-opus-5-5');
    expect(ProviderModelPin.requested([1])).toBeUndefined();
    expect(ProviderModelPin.requested(null)).toBeUndefined();
  });
});
