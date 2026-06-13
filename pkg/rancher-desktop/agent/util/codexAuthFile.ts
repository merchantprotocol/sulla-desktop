// ~/.codex/auth.json — the Codex CLI's credential store.
//
// The Lima VM mounts the host home directory writable at the same path, so a
// single file serves both sides: Sulla's OAuth layer writes it from the host
// (on initial sign-in and on every scheduled refresh), and the codex CLI
// inside the VM reads it and self-refreshes tokens in place. With ChatGPT
// sign-in tokens present, codex usage draws from the user's ChatGPT plan —
// no metered API billing.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { OAuthTokenSet } from '../integrations/oauth/OAuthProvider';

export function codexHomeDir(): string {
  return path.join(os.homedir(), '.codex');
}

export function codexAuthPath(): string {
  return path.join(codexHomeDir(), 'auth.json');
}

/**
 * Pull the ChatGPT account id out of the id_token JWT — codex routes plan
 * usage through it. A missing claim is non-fatal (the CLI re-derives it).
 */
function extractAccountId(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    const auth = claims['https://api.openai.com/auth'];
    return (auth && typeof auth.chatgpt_account_id === 'string') ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

/**
 * Write the codex CLI auth file from an OAuth token set. Returns false (and
 * logs) on failure — callers treat that as "codex not signed in".
 */
export function writeCodexAuthFile(tokens: OAuthTokenSet): boolean {
  if (!tokens?.access_token) return false;
  try {
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
    const payload = {
      OPENAI_API_KEY: null,
      tokens:         {
        id_token:      idToken ?? null,
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        account_id:    extractAccountId(idToken),
      },
      last_refresh: new Date().toISOString(),
    };
    fs.mkdirSync(codexHomeDir(), { recursive: true });
    fs.writeFileSync(codexAuthPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.error('[codexAuthFile] Failed to write auth.json:', err);
    return false;
  }
}

/**
 * Make sure ~/.codex/auth.json exists, rebuilding it from the stored OAuth
 * token row when missing (fresh install, wiped home dir). The file is the
 * CLI's live store — when it already exists we leave it alone, since the CLI
 * may hold fresher tokens than the DB row.
 */
export async function ensureCodexAuthFile(): Promise<boolean> {
  if (fs.existsSync(codexAuthPath())) return true;
  try {
    const { getOAuthService } = await import('../services/OAuthService');
    const stored = await getOAuthService().getStoredTokens('codex');
    if (!stored?.raw_response) return false;
    const tokens = (typeof stored.raw_response === 'string'
      ? JSON.parse(stored.raw_response)
      : stored.raw_response) as OAuthTokenSet;
    return writeCodexAuthFile(tokens);
  } catch (err) {
    console.warn('[codexAuthFile] Could not rebuild auth.json from stored tokens:', err);
    return false;
  }
}
