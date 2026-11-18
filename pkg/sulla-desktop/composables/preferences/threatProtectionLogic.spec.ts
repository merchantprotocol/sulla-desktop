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
  it('formats backend byte sizes for the traffic log', () => {
    expect(logic.formatBytes(22)).toBe('22 B');
    expect(logic.formatBytes(49_357)).toBe('48.2 KB');
    expect(logic.formatBytes(1_048_576)).toBe('1.0 MB');
  });
  it('counts only blocked and injection entries inside the last 24 hours', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(logic.countLast24Hours([
      { ts: '2026-11-18T11:00:00Z', verdict: 'blocked' },
      { ts: '2026-11-17T13:00:00Z', verdict: 'injection' },
      { ts: '2026-11-17T11:59:59Z', verdict: 'blocked' },
      { ts: '2026-11-18T10:00:00Z', verdict: 'failed_open' },
    ], now)).toEqual({ blocked: 1, injection: 1 });
  });
  it('round-trips comma-delimited allowlists and builds only selected log filters', () => {
    expect(logic.allowlist(' a.example, ,b.example ')).toEqual(['a.example', 'b.example']);
    expect(logic.logRequest('', '')).toEqual({ limit: 200, verdict: undefined, search: undefined });
    expect(logic.logRequest('api.example', 'blocked')).toEqual({ limit: 200, verdict: 'blocked', search: 'api.example' });
  });
});
