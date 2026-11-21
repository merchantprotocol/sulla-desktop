// SPDX-License-Identifier: GPL-2.0-or-later

import { marked } from 'marked';

const DOCUMENT_TAG = /<style\b|<script\b|<!doctype\b|<html\b|<body\b|<head\b/i;

export class InlineReplyMarkup {
  render(text: string, legacyHtml = false): { html: string; isolated: boolean } {
    if (legacyHtml) return { html: text, isolated: true };

    const tokens = marked.lexer(text);
    let isolated = false;
    // Markdown code tokens (including an unclosed fence during streaming)
    // must never be treated as raw HTML, even if they contain a whole page.
    marked.walkTokens(tokens, token => {
      if (token.type === 'html' && DOCUMENT_TAG.test(token.raw)) isolated = true;
    });
    return { html: marked.parser(tokens), isolated };
  }
}
