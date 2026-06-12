// RecallIndexService.ts
// Redis-backed citation index for the memory-recall subconscious agent.
// The recall agent re-researches skills/projects/docs from scratch every turn;
// this index makes that research cumulative. Digests produced on one turn are
// stored against the source file's content hash, so later turns (and later
// sessions) can reuse them with a cheap stat/hash check instead of an LLM
// re-read. Topic sets group citations so a single lookup can answer
// "what do we already know about X".
//
// Key schema (namespaced, non-destructive to existing keys):
//   sulla_recall_index:file:<absolute path>   → JSON FileIndexEntry
//   sulla_recall_index:topic:<normalized>     → JSON TopicIndexEntry
//
// Entries carry a 24h TTL, refreshed on every hit — consistent with the
// PR #443 cache_ttl conventions for subconscious digests.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { redisClient } from '../database/RedisClient';

// ============================================================================
// TYPES
// ============================================================================

export interface FileIndexEntry {
  /** sha256 hex of the file contents at digest time */
  contentHash: string;
  /** Fast freshness check — avoids re-hashing untouched files */
  mtimeMs:     number;
  size:        number;
  /** Trusted-citation digest of the file (recall agent output format) */
  digest:      string;
  updatedAt:   number;
}

export interface TopicIndexEntry {
  /** Citation refs — digest blocks and/or source file paths */
  citations: string[];
  updatedAt: number;
}

export interface FileLookupResult {
  path:    string;
  /** fresh: digest is current. stale: file changed, entry dropped. miss: never indexed. */
  status:  'fresh' | 'stale' | 'miss';
  digest?: string;
}

// ============================================================================
// REDIS KEYS
// ============================================================================

const FILE_KEY_PREFIX = 'sulla_recall_index:file:';
const TOPIC_KEY_PREFIX = 'sulla_recall_index:topic:';

/** 24h, refreshed on every hit — matches PR #443 subconscious cache TTL conventions */
const ENTRY_TTL_SECONDS = 24 * 60 * 60;

// ============================================================================
// SERVICE
// ============================================================================

let indexInstance: RecallIndexService | null = null;

export function getRecallIndexService(): RecallIndexService {
  if (!indexInstance) {
    indexInstance = new RecallIndexService();
  }
  return indexInstance;
}

export class RecallIndexService {
  /** Expand ~ and resolve to an absolute path — file keys must be canonical. */
  expandPath(filePath: string): string {
    let expanded = String(filePath || '').trim();
    if (expanded.startsWith('~/')) {
      expanded = expanded.replace('~', os.homedir());
    } else if (expanded === '~') {
      expanded = os.homedir();
    }
    return path.resolve(expanded);
  }

  /** Normalize a topic for keying — lowercase, alphanumeric tokens joined by dashes. */
  normalizeTopic(topic: string): string {
    return String(topic || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 128);
  }

  private hashContent(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private fileKey(absPath: string): string {
    return `${ FILE_KEY_PREFIX }${ absPath }`;
  }

  private topicKey(topic: string): string {
    return `${ TOPIC_KEY_PREFIX }${ this.normalizeTopic(topic) }`;
  }

  // ------------------------------------------------------------------
  // FILE ENTRIES
  // ------------------------------------------------------------------

  /**
   * Look up a file's cached digest and verify it is still current.
   * Verification is non-LLM and cheap: stat first (mtime+size), and only
   * re-hash the content when the stat changed. Stale entries are dropped
   * on sight — no background sweeper needed.
   */
  async lookupFile(filePath: string): Promise<FileLookupResult> {
    const absPath = this.expandPath(filePath);
    const key = this.fileKey(absPath);

    const raw = await redisClient.get(key);
    if (!raw) {
      return { path: absPath, status: 'miss' };
    }

    let entry: FileIndexEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      await redisClient.del(key);
      return { path: absPath, status: 'miss' };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      // Source file deleted/moved — the digest no longer cites anything real.
      await redisClient.del(key);
      return { path: absPath, status: 'stale' };
    }

    // Fast path: untouched file → digest is current. Refresh TTL on hit.
    if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) {
      await redisClient.expire(key, ENTRY_TTL_SECONDS);
      return { path: absPath, status: 'fresh', digest: entry.digest };
    }

    // Stat changed — confirm with a content hash (touched-but-unchanged files).
    try {
      const contentHash = this.hashContent(fs.readFileSync(absPath));
      if (contentHash === entry.contentHash) {
        entry.mtimeMs = stat.mtimeMs;
        entry.size = stat.size;
        await redisClient.set(key, JSON.stringify(entry), ENTRY_TTL_SECONDS);
        return { path: absPath, status: 'fresh', digest: entry.digest };
      }
    } catch {
      // fall through to stale
    }

    // Content really changed — drop the entry so it gets re-researched.
    await redisClient.del(key);
    return { path: absPath, status: 'stale' };
  }

  /** Store a fresh digest for a file, keyed by its current content hash. */
  async storeFile(filePath: string, digest: string): Promise<void> {
    const absPath = this.expandPath(filePath);
    const stat = fs.statSync(absPath);
    const contentHash = this.hashContent(fs.readFileSync(absPath));

    const entry: FileIndexEntry = {
      contentHash,
      mtimeMs:   stat.mtimeMs,
      size:      stat.size,
      digest:    String(digest || '').trim(),
      updatedAt: Date.now(),
    };

    await redisClient.set(this.fileKey(absPath), JSON.stringify(entry), ENTRY_TTL_SECONDS);
  }

  // ------------------------------------------------------------------
  // TOPIC ENTRIES
  // ------------------------------------------------------------------

  /** Look up the citation set for a topic. Refreshes TTL on hit. */
  async lookupTopic(topic: string): Promise<TopicIndexEntry | null> {
    const key = this.topicKey(topic);
    const raw = await redisClient.get(key);
    if (!raw) return null;

    let entry: TopicIndexEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      await redisClient.del(key);
      return null;
    }

    await redisClient.expire(key, ENTRY_TTL_SECONDS);
    return entry;
  }

  /** Store (merge) citation refs under a topic. Existing refs are kept, duplicates dropped. */
  async storeTopic(topic: string, citations: string[]): Promise<void> {
    const key = this.topicKey(topic);
    const incoming = (citations || []).map(c => String(c || '').trim()).filter(Boolean);

    const existing = await this.lookupTopic(topic);
    const merged = Array.from(new Set([...(existing?.citations || []), ...incoming]));

    const entry: TopicIndexEntry = {
      citations: merged,
      updatedAt: Date.now(),
    };

    await redisClient.set(key, JSON.stringify(entry), ENTRY_TTL_SECONDS);
  }
}
