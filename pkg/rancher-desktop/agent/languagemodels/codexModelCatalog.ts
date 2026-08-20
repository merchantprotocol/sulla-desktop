// Dynamic OpenAI Codex model catalog.
//
// The Codex model list is NOT hardcoded anywhere. It is read live from the
// codex CLI's own catalog (`codex debug models`, which renders the raw model
// list as JSON), invoked *through Sulla* inside the Lima VM so the ChatGPT
// OAuth credentials Sulla stores in the vault (~/.codex/auth.json) are injected
// — a bare terminal `codex` call would have no credentials and return a
// degraded/empty catalog. `ensureCodexAuthFile()` rebuilds that auth file from
// the stored OAuth token before we spawn.
//
// The catalog carries a `visibility` field per model; only `visibility: 'list'`
// entries are user-selectable (the rest are internal/hidden, e.g. auto-review).
// We prepend the provider-agnostic "Auto (CLI default)" sentinel (`codex`),
// which maps to "omit --model and let the CLI pick" in CodexService.

import { runCommand } from '../tools/util/CommandRunner';
import { ensureCodexAuthFile, codexHomeDir } from '../util/codexAuthFile';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface CodexCatalogModel {
  id:           string;
  name:         string;
  description?: string;
}

/** "Auto" = omit --model so the codex CLI uses its configured default. This is
 *  the one provider-agnostic entry; it is a mode, not a hardcoded model name. */
const AUTO_SENTINEL: CodexCatalogModel = {
  id:          'codex',
  name:        'Auto (CLI default)',
  description: 'Let Codex choose the best model automatically',
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; models: CodexCatalogModel[] } | null = null;

interface RawCodexModel {
  slug?:         string;
  display_name?: string;
  description?:  string;
  visibility?:   string;
}

/** POSIX single-quote escape — literal in sh, no expansion fires. */
function shq(s: string): string {
  return `'${ s.replace(/'/g, "'\\''") }'`;
}

/**
 * Return the live Codex model catalog: the "Auto" sentinel followed by every
 * user-visible model the codex CLI reports for the signed-in account. Never
 * throws and never returns a hardcoded model list — on any failure it degrades
 * to just the Auto sentinel so the picker still works.
 *
 * @param opts.force — bypass the short in-memory cache (used by explicit
 *   "refresh models" actions; the picker's routine reads hit the cache).
 */
export async function listCodexModels(opts?: { force?: boolean }): Promise<CodexCatalogModel[]> {
  if (!opts?.force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.models;
  }

  // Inject the vault OAuth credentials into ~/.codex/auth.json before asking
  // the CLI for its catalog. This is the "call codex through Sulla" step — a
  // missing/stale auth file yields an unauthenticated, degraded catalog.
  try {
    await ensureCodexAuthFile();
  } catch (err) {
    log.warn(`[codexModelCatalog] ensureCodexAuthFile failed (continuing — a live auth file may still exist): ${ err }`);
  }

  // CODEX_HOME pins the CLI to the host-mounted ~/.codex (limactl shell would
  // otherwise resolve HOME to the guest path and miss the auth file). runCommand
  // already exports HOME=<macHome>, so $HOME/.codex == codexHomeDir(); we set
  // CODEX_HOME explicitly to match CodexService's spawn exactly.
  const command = `export CODEX_HOME=${ shq(codexHomeDir()) }; codex debug models`;

  try {
    const { stdout, exitCode } = await runCommand(command, [], {
      runInLimaShell: true,
      timeoutMs:      20_000,
      // The raw catalog embeds per-model base instructions and can run to a few
      // hundred KB; keep the ceiling well clear so the JSON is never truncated.
      maxOutputChars: 5_000_000,
    });

    if (exitCode !== 0) {
      throw new Error(`codex debug models exited ${ exitCode }`);
    }

    const parsed = JSON.parse(stdout) as { models?: RawCodexModel[] };
    const dynamic = (parsed.models ?? [])
      .filter(m => m.slug && m.visibility === 'list')
      .map(m => ({ id: m.slug!, name: m.display_name || m.slug!, description: m.description }));

    const models = [AUTO_SENTINEL, ...dynamic];
    cache = { at: Date.now(), models };
    log.log(`[codexModelCatalog] Loaded ${ dynamic.length } visible codex models from live catalog`);
    return models;
  } catch (err) {
    log.warn(`[codexModelCatalog] Failed to load dynamic codex catalog — returning Auto only (no hardcoded fallback): ${ err }`);
    return [AUTO_SENTINEL];
  }
}
