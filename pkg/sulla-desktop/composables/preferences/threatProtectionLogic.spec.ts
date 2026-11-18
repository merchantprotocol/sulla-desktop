// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ThreatProtectionLogic } from './threatProtectionLogic';

describe('ThreatProtectionLogic', () => {
  const logic = new ThreatProtectionLogic();
  it('validates normalized hostnames while refusing URL fragments and malformed labels', () => {
    expect(logic.isValidHost(' Example.COM ')).toBe(true);
    expect(logic.isValidHost('https://example.com')).toBe(false);
    expect(logic.isValidHost('-bad.example')).toBe(false);
    expect(logic.isValidHost('example..com')).toBe(false);
  });
  it('converts displayed MiB to exact backend bytes', () => {
    expect(logic.megabytesToBytes(2)).toBe(2_097_152);
    expect(logic.megabytesToBytes(0.5)).toBe(524_288);
  });
  it('round-trips comma-delimited allowlists and builds only selected log filters', () => {
    expect(logic.allowlist(' a.example, ,b.example ')).toEqual(['a.example', 'b.example']);
    expect(logic.logRequest('', '')).toEqual({ limit: 200, verdict: undefined, search: undefined });
    expect(logic.logRequest('api.example', 'blocked')).toEqual({ limit: 200, verdict: 'blocked', search: 'api.example' });
  });
});
