import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GrepMatch {
  /** Absolute path to the matching file */
  filePath:   string;
  /** The folder name containing the file (used as slug) */
  folderName: string;
}

export interface GrepSearchResult {
  matches:        GrepMatch[];
  attemptedTerms: string[];
  searchedDirs:   string[];
}

/**
 * Run grep on filesystem directories to find matching .md files.
 *
 * Strategy:
 * 1. Try the exact query as a single grep pattern (case-insensitive).
 * 2. If no results, extract multi-word phrases (2+ consecutive words) and grep each.
 * 3. If still no results, grep each individual word.
 *
 * Returns deduplicated list of matching files sorted by number of pattern hits (most relevant first).
 */
export async function grepSearchFiles(
  query: string,
  dirs: string[],
  fileGlob = '*.md',
): Promise<GrepMatch[]> {
  const result = await grepSearchFilesDetailed(query, dirs, fileGlob);
  return result.matches;
}

export async function grepSearchFilesDetailed(
  query: string,
  dirs: string[],
  fileGlob = '*.md',
): Promise<GrepSearchResult> {
  const q = String(query || '').trim();
  if (!q) {
    return {
      matches:        [],
      attemptedTerms: [],
      searchedDirs:   [],
    };
  }

  const attemptedTerms: string[] = [];
  const pushAttemptedTerm = (term: string) => {
    if (!term) return;
    if (!attemptedTerms.includes(term)) attemptedTerms.push(term);
  };

  const existingDirs = dirs.filter(d => {
    try { return fs.statSync(d).isDirectory() } catch { return false }
  });
  if (existingDirs.length === 0) {
    pushAttemptedTerm(q);
    return {
      matches:      [],
      attemptedTerms,
      searchedDirs: [],
    };
  }

  // 1. Try exact query
  pushAttemptedTerm(q);
  const exactHits = await runGrep(q, existingDirs, fileGlob);
  if (exactHits.length > 0) {
    return {
      matches:      dedupeAndRank(exactHits),
      attemptedTerms,
      searchedDirs: existingDirs,
    };
  }

  // 2. Try phrases (sliding window of 2+ words)
  const words = q.split(/\s+/).filter(w => w.length >= 2);
  if (words.length >= 2) {
    const phraseHits = new Map<string, number>();
    for (let len = words.length - 1; len >= 2; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        pushAttemptedTerm(phrase);
        const hits = await runGrep(phrase, existingDirs, fileGlob);
        for (const h of hits) {
          phraseHits.set(h.filePath, (phraseHits.get(h.filePath) || 0) + len);
        }
      }
    }
    if (phraseHits.size > 0) {
      return {
        matches:      rankMap(phraseHits),
        attemptedTerms,
        searchedDirs: existingDirs,
      };
    }
  }

  // 3. Fall back to individual words
  const wordHits = new Map<string, number>();
  for (const word of words) {
    pushAttemptedTerm(word);
    const hits = await runGrep(word, existingDirs, fileGlob);
    for (const h of hits) {
      wordHits.set(h.filePath, (wordHits.get(h.filePath) || 0) + 1);
    }
  }

  return {
    matches:      rankMap(wordHits),
    attemptedTerms,
    searchedDirs: existingDirs,
  };
}

function runGrep(pattern: string, dirs: string[], fileGlob: string): Promise<GrepMatch[]> {
  return new Promise((resolve) => {
    // grep -ril: recursive, case-insensitive, files-with-matches
    const args = [
      '-ril',
      '--include', fileGlob,
      '--',
      pattern,
      ...dirs,
    ];

    execFile('grep', args, { maxBuffer: 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        // grep exits 1 when no matches — not an error
        resolve([]);
        return;
      }

      const matches = stdout
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(filePath => ({
          filePath,
          folderName: path.basename(path.dirname(filePath)),
        }));

      resolve(matches);
    });
  });
}

function dedupeAndRank(hits: GrepMatch[]): GrepMatch[] {
  const seen = new Map<string, GrepMatch>();
  for (const h of hits) {
    if (!seen.has(h.filePath)) seen.set(h.filePath, h);
  }
  return Array.from(seen.values());
}

function rankMap(hitCounts: Map<string, number>): GrepMatch[] {
  return Array.from(hitCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([filePath]) => ({
      filePath,
      folderName: path.basename(path.dirname(filePath)),
    }));
}
