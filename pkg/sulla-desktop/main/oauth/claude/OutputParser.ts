// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const STREAM_TOKEN = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})(?=[\s\x07\x1B])/;
const FINAL_TOKEN = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})/;
const AUTHORIZE_URL = /(https?:\/\/(?:[\w-]+\.)*claude\.(?:com|ai)\/[\s\S]+?state=[A-Za-z0-9_-]+)(?=[\s\x07\x1B])/;

export interface ClaudeSetupOutput {
  text:         string;
  authorizeUrl: string | null;
  token:        string | null;
  providerError: string | null;
}

/** Pure incremental parser for the terminal stream emitted by `claude setup-token`. */
export class OutputParser {
  private raw = '';

  push(chunk: string): ClaudeSetupOutput {
    this.raw += chunk;
    return this.snapshot(false);
  }

  finish(): ClaudeSetupOutput {
    return this.snapshot(true);
  }

  static parse(raw: string): ClaudeSetupOutput {
    const parser = new OutputParser();

    parser.raw = raw;
    return parser.finish();
  }

  private snapshot(final: boolean): ClaudeSetupOutput {
    const text = OutputParser.clean(this.raw);
    const url = AUTHORIZE_URL.exec(text)?.[1]?.replace(/\s+/g, '') ?? null;
    const token = (final ? FINAL_TOKEN : STREAM_TOKEN).exec(text)?.[1] ?? null;
    const providerError = /OAuth error:\s*([^\n]*)/i.exec(text)?.[1]?.trim() || null;

    return { text, authorizeUrl: url, token, providerError };
  }

  static clean(raw: string): string {
    return raw
      // OSC-8 hyperlinks carry the real URL as their target. Parsing the full
      // accumulated stream also handles escape sequences split across chunks.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\]8;[^;\x07\x1B]*;([^\x07\x1B]*)(?:\x1B\\|\x07)/g, (_match, target: string) => target ? ` ${ target } ` : ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\][^\x07\x1B]*(?:\x1B\\|\x07)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\[[0-9;?<>=]*[a-zA-Z~]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }
}
