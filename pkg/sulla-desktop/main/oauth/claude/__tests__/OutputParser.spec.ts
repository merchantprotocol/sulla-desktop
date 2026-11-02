// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { OutputParser } from '../OutputParser';

const FAKE_TOKEN = `sk-ant-oat01-${ 'fixture_only_'.repeat(5) }`;
const AUTH_URL = 'https://claude.ai/oauth/authorize?client_id=fixture&state=state_fixture';

describe('Claude setup-token OutputParser', () => {
  it.each([
    ['missing CLI', 'sh: claude: command not found\r\n'],
    ['missing guest PTY', 'openpty failed: No such file or directory\r\n'],
  ])('does not invent credentials from the historical %s failure', (_name, fixture) => {
    const parsed = new OutputParser().push(fixture);

    expect(parsed.authorizeUrl).toBeNull();
    expect(parsed.token).toBeNull();
  });

  it('normalizes cooked-terminal CR and LF output', () => {
    const parsed = new OutputParser().push(`Paste code:\rOAuth error: fixture rejected\r\nRetry\n`);

    expect(parsed.text).toBe('Paste code:\nOAuth error: fixture rejected\nRetry\n');
    expect(parsed.providerError).toBe('fixture rejected');
  });

  it('buffers a URL split across chunks instead of matching a partial state', () => {
    const parser = new OutputParser();

    expect(parser.push(`${ AUTH_URL.slice(0, -5) }`).authorizeUrl).toBeNull();
    expect(parser.push(`${ AUTH_URL.slice(-5) }\r`).authorizeUrl).toBe(AUTH_URL);
  });

  it('extracts the target from an OSC-8 hyperlink split across chunks', () => {
    const parser = new OutputParser();

    parser.push(`\u001b]8;;${ AUTH_URL.slice(0, 35) }`);
    const parsed = parser.push(`${ AUTH_URL.slice(35) }\u001b\\Open Claude\u001b]8;;\u001b\\\r\n`);

    expect(parsed.authorizeUrl).toBe(AUTH_URL);
    expect(parsed.text).not.toContain('\u001b');
  });

  it('waits for a token delimiter while streaming and accepts end-of-stream on exit', () => {
    const parser = new OutputParser();

    expect(parser.push(FAKE_TOKEN).token).toBeNull();
    expect(parser.finish().token).toBe(FAKE_TOKEN);
  });

  it('preserves the masked-code echo used to trigger Enter', () => {
    const parsed = new OutputParser().push('Paste code: ******************************\r\n');

    expect(parsed.text).toContain('******************************');
  });
});
