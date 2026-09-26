import { mayInjectSecretIntoAgentCode, resolveLlmAccess, AGENT_PROTECTED_PROPERTIES } from '../vaultAccessPolicy';
import { parseCSV } from '../vaultImportParsers';

describe('parseCSV', () => {
  it('keeps multi-line quoted notes in one record (old line splitter shifted passwords)', () => {
    const csv = [
      'name,login_uri,login_username,login_password,notes',
      '"Bank","https://bank.example","me","p,a""ss","line one',
      'line two, with comma"',
      'Mail,https://mail.example,me2,pw2,',
    ].join('\r\n');

    expect(parseCSV(`﻿${ csv }\r\n`)).toEqual([
      ['name', 'login_uri', 'login_username', 'login_password', 'notes'],
      ['Bank', 'https://bank.example', 'me', 'p,a"ss', 'line one\r\nline two, with comma'],
      ['Mail', 'https://mail.example', 'me2', 'pw2', ''],
    ]);
  });

  it('handles blank lines, lone CR, and a missing trailing newline', () => {
    expect(parseCSV('a,b\n\n1,2\r3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('parses 10k rows quickly', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `site${ i },"u${ i }","p""${ i }","n\n${ i }"`);
    const started = Date.now();
    const out = parseCSV(`name,user,pass,notes\n${ rows.join('\n') }`);

    expect(out).toHaveLength(10_001);
    expect(out[5000]).toEqual(['site4999', 'u4999', 'p"4999', 'n\n4999']);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('vault access policy', () => {
  it('agents may not write llm_access', () => {
    expect(AGENT_PROTECTED_PROPERTIES.has('llm_access')).toBe(true);
  });

  it('defaults unknown levels to autofill', () => {
    expect(resolveLlmAccess(undefined)).toBe('autofill');
    expect(resolveLlmAccess('FULL')).toBe('autofill');
    expect(resolveLlmAccess('full')).toBe('full');
  });

  it.each([
    ['website', 'none', false],
    ['website', 'metadata', false],
    ['website', 'autofill', false],
    ['website', 'full', true],
    ['github', 'none', false],
    ['github', 'metadata', false],
    ['github', 'autofill', true],
    ['github', 'full', true],
  ] as const)('%s at %s → inject=%s', (integration, level, allowed) => {
    expect(mayInjectSecretIntoAgentCode(integration, level)).toBe(allowed);
  });
});
