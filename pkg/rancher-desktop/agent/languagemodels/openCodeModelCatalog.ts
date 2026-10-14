import { runCommand } from '../tools/util/CommandRunner';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface OpenCodeCatalogModel {
  id:           string;
  name:         string;
  description?: string;
}

const AUTO: OpenCodeCatalogModel = {
  id:          'opencode',
  name:        'Auto (CLI default)',
  description: 'Let OpenCode choose its configured default model',
};
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; models: OpenCodeCatalogModel[] } | null = null;

export async function listOpenCodeModels(opts?: { force?: boolean }): Promise<OpenCodeCatalogModel[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  try {
    const result = await runCommand('export PATH="$HOME/.local/bin:/mnt/data/npm-global/bin:$PATH"; opencode models', [], { runInLimaShell: true, timeoutMs: 30_000, maxOutputChars: 1_000_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${ result.exitCode }`);
    const ids = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[^\s]+\/[^\s]+$/.test(line));
    const models = [AUTO, ...Array.from(new Set(ids)).map(id => ({ id, name: id }))];
    cache = { at: Date.now(), models };
    return models;
  } catch (err) {
    log.warn(`[openCodeModelCatalog] Model discovery failed: ${ err }`);
    return [AUTO];
  }
}
