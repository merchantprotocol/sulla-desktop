// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getBuiltinAgentSpecs, renderBuiltinAgent } from '../../builtinAgents/index';
import { isModelRoutingAlias } from '../../languagemodels/modelSlotRouting';
import { cleanVoiceTurnId, VOICE_AGENT_ID, voiceTurnRoute } from '../voiceTurn';

describe('which agent a mobile relay turn runs on', () => {
  it('leaves typed turns to the phone picker', () => {
    expect(voiceTurnRoute({})).toBeNull();
    expect(voiceTurnRoute({ voiceMode: false, voiceTurnId: 'vt_abc_1' })).toBeNull();
    expect(voiceTurnRoute(null)).toBeNull();
  });

  it('never locks spoken turns to the voice agent', () => {
    expect(voiceTurnRoute({ voiceMode: true })).toEqual({});
    expect(voiceTurnRoute({ voiceMode: true, voiceTurnId: 'vt_mh2k9x_1' })).toEqual({ voiceTurnId: 'vt_mh2k9x_1' });
    const frame = { voiceMode: true, providerId: 'claude-code', modelId: 'claude-opus-5-5', agentId: 'director' };
    expect(voiceTurnRoute(frame)).not.toHaveProperty('agentId');
  });

  it('only accepts content-free trace ids', () => {
    expect(cleanVoiceTurnId('vt_mh2k9x_1a')).toBe('vt_mh2k9x_1a');
    expect(cleanVoiceTurnId('hello there')).toBe('');
    expect(cleanVoiceTurnId('vt_')).toBe('');
    expect(cleanVoiceTurnId(42)).toBe('');
    expect(voiceTurnRoute({ voiceMode: true, voiceTurnId: 'what did I say' })).toEqual({});
  });
});

describe('voice agent definition', () => {
  const spec = getBuiltinAgentSpecs().find(candidate => candidate.slug === VOICE_AGENT_ID)!;

  it('asks for the fast tier and skips the recall prelude', () => {
    const rendered = renderBuiltinAgent(spec);
    expect(rendered.model).toBe('fast');
    expect(rendered.model_slot).toBeNull();
    expect(rendered.provider).toBeNull();
    expect(rendered.config.injectObservations).toBe(false);
  });

  it('keeps the sections a spoken turn still needs', () => {
    const excluded = spec.config?.exclude_sections as string[];
    for (const kept of ['identity', 'soul', 'safety', 'tooling', 'trust', 'completion_wrappers', 'agent_prompt']) {
      expect(excluded).not.toContain(kept);
    }
  });
});

describe('model routing aliases', () => {
  it('treats slot and tier names as aliases, never as pinned model ids', () => {
    for (const alias of ['primary', 'secondary', 'subconscious', 'fast', 'balanced', 'powerful']) {
      expect(isModelRoutingAlias(alias)).toBe(true);
    }
    expect(isModelRoutingAlias('claude-haiku-5-5')).toBe(false);
    expect(isModelRoutingAlias(undefined)).toBe(false);
  });
});
