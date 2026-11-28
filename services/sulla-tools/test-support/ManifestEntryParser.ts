// SPDX-License-Identifier: GPL-2.0-or-later
export interface ParsedManifestEntry {
  category?: string;
  name?: string;
  executionTarget?: string;
  /** Module path from `loader: () => import('./x')`. */
  loader?: string;
}

interface Span { start: number; end: number }

const QUOTED_VALUE = /^\s*(['"])([^'"\n]*)\1/;
const LOADER_VALUE = /^\s*\(\)\s*=>\s*import\(\s*(['"])([^'"\n]+)\1\s*\)/;
const TOP_LEVEL_KEY = /\b(category|name|executionTarget|loader)\s*:/g;

/**
 * Splits a manifests.ts array literal into its object entries and reads only the
 * top-level keys of each one. Entries may span lines; nested schemas, strings and
 * comments cannot leak keys into the result.
 */
export class ManifestEntryParser {
  parse(source: string): ParsedManifestEntry[] {
    return this.entrySpans(source).map(span => this.parseEntry(source.slice(span.start, span.end + 1)));
  }

  private entrySpans(source: string): Span[] {
    const spans: Span[] = [];
    let start = -1;
    this.walk(source, (char, index, depth, code) => {
      if (!code) return;
      if (char === '{' && depth === 1) start = index;
      if (char === '}' && depth === 2) spans.push({ start, end: index });
    });
    return spans;
  }

  private parseEntry(text: string): ParsedManifestEntry {
    const masked = this.maskNested(text);
    const entry: ParsedManifestEntry = {};
    for (const match of masked.matchAll(TOP_LEVEL_KEY)) {
      const rest = text.slice(match.index + match[0].length);
      if (match[1] === 'loader') entry.loader ??= LOADER_VALUE.exec(rest)?.[2];
      else if (match[1] === 'category') entry.category ??= QUOTED_VALUE.exec(rest)?.[2];
      else if (match[1] === 'name') entry.name ??= QUOTED_VALUE.exec(rest)?.[2];
      else entry.executionTarget ??= QUOTED_VALUE.exec(rest)?.[2];
    }
    return entry;
  }

  /** Keeps only characters at the entry's own nesting level; everything else becomes a space. */
  private maskNested(text: string): string {
    let masked = '';
    this.walk(text, (char, _index, depth, code) => {
      const level = '}])'.includes(char) ? depth - 1 : depth;
      masked += code && level === 1 ? char : ' ';
    });
    return masked;
  }

  /** Visits every character with the bracket depth before it; `code` is false inside strings and comments. */
  private walk(source: string, visit: (char: string, index: number, depth: number, code: boolean) => void): void {
    let depth = 0;
    let quote: string | undefined;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        visit(char, index, depth, false);
        if (char === '\\' && index + 1 < source.length) {
          index++;
          visit(source[index], index, depth, false);
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === '/' && source[index + 1] === '/') {
        for (; index < source.length && source[index] !== '\n'; index++) visit(source[index], index, depth, false);
        index--;
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        quote = char;
        visit(char, index, depth, false);
        continue;
      }
      visit(char, index, depth, true);
      if ('{[('.includes(char)) depth++;
      else if ('}])'.includes(char)) depth--;
    }
  }
}
