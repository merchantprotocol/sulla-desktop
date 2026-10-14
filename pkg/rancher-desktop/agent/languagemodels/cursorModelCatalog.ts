import { runCommand } from '../tools/util/CommandRunner';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface CursorCatalogModel {
  id:           string;
  name:         string;
  description?: string;
}

const AUTO: CursorCatalogModel = {
  id:          'cursor',
  name:        'Auto (Cursor default)',
  description: 'Let Cursor Agent select the default model for your account',
};
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; models: CursorCatalogModel[] } | null = null;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export async function listCursorModels(opts?: { force?: boolean }): Promise<CursorCatalogModel[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  try {
    const result = await runCommand('export PATH="$HOME/.local/bin:/mnt/data/npm-global/bin:$PATH"; cursor-agent --list-models', [], { runInLimaShell: true, timeoutMs: 30_000, maxOutputChars: 200_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${ result.exitCode }`);
    const ids = stripAnsi(result.stdout).split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !/^available models/i.test(line))
      .map(line => line.replace(/^[-*]\s*/, '').split(/\s{2,}/)[0].trim())
      .filter(id => /^[A-Za-z0-9][A-Za-z0-9._:[\]/=-]*$/.test(id));
    const models = [AUTO, ...Array.from(new Set(ids)).map(id => ({ id, name: id }))];
    cache = { at: Date.now(), models };
    return models;
  } catch (err) {
    log.warn(`[cursorModelCatalog] Model discovery failed: ${ err }`);
    return [AUTO];
  }
}
