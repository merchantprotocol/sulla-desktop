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

const CODEX_AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

function decodeJwtExpiry(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));

    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isAuthFileFresh(): boolean {
  try {
    const payload = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8'));
    const accessToken = payload?.tokens?.access_token;
    if (!accessToken) return false;

    const expiresAt = decodeJwtExpiry(accessToken);
    if (!expiresAt) {
      // Some future Codex token shapes may be opaque. If there is an access
      // token but no JWT exp claim, keep the CLI as the authority.
      return true;
    }

    return Date.now() < expiresAt - CODEX_AUTH_REFRESH_BUFFER_MS;
  } catch {
    return false;
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
 * Point the VM user's ~/.codex at the host's ~/.codex.
 *
 * `limactl shell` runs with HOME=/home/<user>.linux, so a plain `codex` in the
 * VM (an agent's exec, a terminal) looked for its login there and reported
 * "Not logged in" even though the host-path auth.json was fresh. Only
 * CodexService, which forces CODEX_HOME, saw it. The symlink gives every
 * `codex` in the VM the same login. Idempotent; a real directory already at
 * the VM path is moved aside, never deleted.
 */
export async function linkCodexHomeIntoVm(): Promise<void> {
  if (typeof process !== 'undefined' && process.type === 'renderer') return;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const target = codexHomeDir();
  const script = [
    't="$1"; d="$HOME/.codex"',
    'if [ -L "$d" ]; then [ "$(readlink "$d")" = "$t" ] && exit 0; rm "$d";',
    'elif [ -e "$d" ]; then mv "$d" "$d.vm-backup-$(date +%s)"; fi',
    'ln -s "$t" "$d"',
  ].join('\n');
  try {
    const { default: paths } = await import('@pkg/utils/paths');
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      execFile(paths.limactl, ['shell', '0', '--', 'sh', '-c', script, 'sh', target], {
        env:     { ...process.env, LIMA_HOME: paths.lima },
        timeout: 30_000,
      }, err => (err ? reject(err) : resolve()));
    });
    console.log(`[codexAuthFile] VM ~/.codex linked to ${ target }`);
  } catch (err) {
    console.warn('[codexAuthFile] Could not link ~/.codex into the VM (VM not running?):', err);
  }
}

/** Delete ~/.codex/auth.json — called when the codex integration is
 *  disconnected so the CLI stops authenticating with revoked credentials. */
export function removeCodexAuthFile(): void {
  try {
    fs.unlinkSync(codexAuthPath());
  } catch { /* already gone */ }
}

/**
 * Make sure ~/.codex/auth.json exists, rebuilding it from the stored OAuth
 * token row when missing (fresh install, wiped home dir). The file is the
 * CLI's live store — when it already exists we leave it alone, since the CLI
 * may hold fresher tokens than the DB row.
 */
export async function ensureCodexAuthFile(): Promise<boolean> {
  if (fs.existsSync(codexAuthPath()) && isAuthFileFresh()) return true;
  try {
    const { getOAuthService } = await import('../services/OAuthService');
    const oauthService = getOAuthService();

    // The UI's OAuth connect flow stores tokens under account id 'oauth';
    // older/headless flows use 'default'. Prefer the integration's active
    // account when one is set.
    const accountIds = ['oauth', 'default'];
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      const active = await getIntegrationService().getActiveAccountId('codex');
      if (active && !accountIds.includes(active)) accountIds.unshift(active);
    } catch { /* fall back to the known account ids */ }

    for (const accountId of accountIds) {
      try {
        const tokens = await oauthService.ensureFreshTokens('codex', accountId);
        if (writeCodexAuthFile(tokens)) return true;
      } catch {
        const stored = await oauthService.getStoredTokens('codex', accountId);
        if (!stored?.raw_response) continue;
        const tokens = (typeof stored.raw_response === 'string'
          ? JSON.parse(stored.raw_response)
          : stored.raw_response) as OAuthTokenSet;
        if (writeCodexAuthFile(tokens) && isAuthFileFresh()) return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[codexAuthFile] Could not rebuild auth.json from stored tokens:', err);
    return false;
  }
}
