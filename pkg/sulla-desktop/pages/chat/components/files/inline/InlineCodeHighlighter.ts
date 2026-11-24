// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const INLINE_CODE_MAX_LINES = 300;
export const INLINE_CODE_MAX_CHARACTERS = 200_000;

export interface InlineCodeLine {
  number: number;
  html: string;
}

export interface InlineCodePreview {
  lines: InlineCodeLine[];
  text: string;
  truncated: boolean;
  totalLines?: number;
}

const SHARED_KEYWORDS = 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'.split(' ');
const LANGUAGE_KEYWORDS: Record<string, string[]> = {
  js: SHARED_KEYWORDS.concat('false null true undefined'.split(' ')),
  jsx: SHARED_KEYWORDS.concat('false null true undefined'.split(' ')),
  mjs: SHARED_KEYWORDS.concat('false null true undefined'.split(' ')),
  cjs: SHARED_KEYWORDS.concat('false null true undefined'.split(' ')),
  ts: SHARED_KEYWORDS.concat('false null true undefined interface type enum implements declare namespace readonly keyof unknown never'.split(' ')),
  tsx: SHARED_KEYWORDS.concat('false null true undefined interface type enum implements declare namespace readonly keyof unknown never'.split(' ')),
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda nonlocal not or pass raise return True try while with yield None'.split(' '),
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda nonlocal not or pass raise return True try while with yield None'.split(' '),
  json: 'false null true'.split(' '),
  yaml: 'false null true yes no'.split(' '),
  yml: 'false null true yes no'.split(' '),
  sql: 'all alter and as asc begin by case cast check column commit constraint create database default delete desc distinct drop else end exists false from full grant group having in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then true union unique update values view when where'.split(' '),
  sh: 'case do done elif else esac fi for function if in select then time until while'.split(' '),
  bash: 'case do done elif else esac fi for function if in select then time until while'.split(' '),
};

/** Escapes source before adding a small, local token palette. */
export class InlineCodeHighlighter {
  highlight(source: string, language = '', maxLines = INLINE_CODE_MAX_LINES, maxCharacters = INLINE_CODE_MAX_CHARACTERS): InlineCodePreview {
    const safeMaxCharacters = Math.max(1, maxCharacters);
    const safeMaxLines = Math.max(1, maxLines);
    const text = source.slice(0, safeMaxCharacters);
    const sourceTruncated = source.length > safeMaxCharacters;
    const sourceLines = text.split(/\r\n|\n|\r/);
    const lines = sourceLines.slice(0, safeMaxLines).map((line, index) => ({
      number: index + 1,
      html: this.highlightLine(line, language),
    }));
    const truncated = sourceTruncated || sourceLines.length > safeMaxLines;

    return {
      lines,
      text,
      truncated,
      totalLines: truncated ? undefined : sourceLines.length,
    };
  }

  private highlightLine(line: string, language: string): string {
    const extension = this.extension(language);
    const keywords = new Set(LANGUAGE_KEYWORDS[extension] ?? SHARED_KEYWORDS);
    const hashComments = ['py', 'python', 'sh', 'bash', 'yaml', 'yml'].includes(extension);
    const sqlComments = extension === 'sql';
    let output = '';
    let index = 0;

    while (index < line.length) {
      const character = line[index];
      const next = line[index + 1];

      if ((character === '/' && (next === '/' || next === '*')) || (hashComments && character === '#') || (sqlComments && character === '-' && next === '-')) {
        output += this.wrap('comment', line.slice(index));
        break;
      }

      if (character === '"' || character === "'" || character === '`') {
        const end = this.stringEnd(line, index, character);
        output += this.wrap('string', line.slice(index, end));
        index = end;
        continue;
      }

      const number = line.slice(index).match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?n?)/i)?.[0];
      if (number) {
        output += this.wrap('number', number);
        index += number.length;
        continue;
      }

      const identifier = line.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (identifier) {
        output += keywords.has(identifier) ? this.wrap('keyword', identifier) : this.escape(identifier);
        index += identifier.length;
        continue;
      }

      output += this.escape(character);
      index += 1;
    }

    return output;
  }

  private stringEnd(line: string, start: number, quote: string): number {
    let escaped = false;
    for (let index = start + 1; index < line.length; index += 1) {
      if (escaped) {
        escaped = false;
      } else if (line[index] === '\\') {
        escaped = true;
      } else if (line[index] === quote) {
        return index + 1;
      }
    }
    return line.length;
  }

  private extension(language: string): string {
    const extension = language.trim().toLowerCase().split(/[./\\]/).at(-1) ?? '';
    if (extension === 'typescript') return 'ts';
    if (extension === 'javascript') return 'js';
    if (extension === 'python3') return 'python';
    if (extension === 'shell') return 'sh';
    return extension;
  }

  private wrap(kind: 'comment' | 'string' | 'number' | 'keyword', value: string): string {
    return `<span class="inline-code-${kind}">${this.escape(value)}</span>`;
  }

  private escape(value: string): string {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return value.replace(/[&<>"']/g, character => entities[character] ?? character);
  }
}
