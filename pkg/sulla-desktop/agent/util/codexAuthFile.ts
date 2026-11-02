// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// ~/.codex/auth.json — the Codex CLI's credential store.
//
// Sulla's OAuth layer owns the host copy and explicitly transfers it into the
// guest-owned Codex home. The host home is never mounted into the VM.

import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { firstRunTrace } from '../../main/firstRun/firstRunTrace';

import type { OAuthTokenSet } from '../integrations/oauth/OAuthProvider';

const CODEX_AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function codexHomeDir(): string {
  return path.join(app.getPath('userData'), 'codex-home');
}

function legacyCodexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function migrateLegacyCodexAuth(): void {
  if (fs.existsSync(codexAuthPath()) || !fs.existsSync(legacyCodexAuthPath())) return;
  try {
    fs.mkdirSync(codexHomeDir(), { recursive: true });
    fs.copyFileSync(legacyCodexAuthPath(), codexAuthPath(), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(codexAuthPath(), 0o600);
    console.log('[codexAuthFile] Migrated legacy Codex sign-in into Sulla-owned storage');
  } catch (err) {
    console.warn('[codexAuthFile] Could not migrate legacy Codex sign-in:', err);
  }
}

export function codexAuthPath(): string {
  return path.join(codexHomeDir(), 'auth.json');
}

function codexRevocationPath(): string {
  return path.join(codexHomeDir(), 'auth.revoked');
}

async function removeGuestCodexAuthFile(): Promise<void> {
  const { default: paths } = await import('@pkg/utils/paths');
  const { execFile } = await import('child_process');

  await new Promise<void>((resolve, reject) => {
    execFile(paths.sullaRuntime, ['exec', '--', 'sh', '-c', [
      'set -eu',
      'd="$HOME/.codex"',
      // Old releases created this exact guest-side link. Remove the link
      // itself; never append a child path and accidentally follow it into the
      // host credential directory.
      'if [ -L "$d" ]; then rm -- "$d"; exit 0; fi',
      '[ ! -e "$d" ] || [ -d "$d" ]',
      'rm -f -- "$d/auth.json"',
    ].join('\n')], {
      env: { ...process.env }, timeout: 30_000,
    }, err => (err ? reject(err) : resolve()));
  });
}

/** Apply a durable host-side disconnect marker after a stopped VM boots. */
export async function reconcileCodexAuthRevocationInVm(): Promise<void> {
  if (!fs.existsSync(codexRevocationPath())) return;
  await removeGuestCodexAuthFile();
}

/**
 * Pull the ChatGPT account id out of the id_token JWT — codex routes plan
 * usage through it. Non-fatal for the legacy auth-file custody (the CLI
 * re-derives it from a bare auth.json), but the bridge paths (PendingMemoryBridge,
 * the guest ContainerBrokerLease) set this claim as an explicit header
 * themselves, so a missing claim there must fail before spawn rather than
 * silently route to the wrong — or no — ChatGPT account.
 */
export function extractChatgptAccountId(idToken: string | undefined): string | null {
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
export function writeCodexAuthFile(tokens: Partial<OAuthTokenSet>): boolean {
  if (!tokens?.access_token) return false;
  try {
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
    const payload = {
      OPENAI_API_KEY: null,
      tokens:         {
        id_token:      idToken ?? null,
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        account_id:    extractChatgptAccountId(idToken),
      },
      last_refresh: new Date().toISOString(),
    };
    fs.mkdirSync(codexHomeDir(), { recursive: true });
    const temporary = path.join(codexHomeDir(), `.auth.json.${ randomUUID() }`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, codexAuthPath());
      fs.chmodSync(codexAuthPath(), 0o600);
      try { fs.unlinkSync(codexRevocationPath()) } catch { /* no prior revocation marker */ }
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* rename succeeded or write failed */ }
    }
    return true;
  } catch (err) {
    console.error('[codexAuthFile] Failed to write auth.json:', err);
    return false;
  }
}

export type CodexAuthPreparationResult =
  | { custody: 'vault-bridge'; written: false; linked: false }
  | { custody: 'auth-file'; written: true; linked: boolean };

/**
 * Prepare raw Codex OAuth credentials for the legacy/first-run CLI path.
 *
 * A container-vault exchange has already persisted the credentials and only
 * returns sanitized metadata. It must never be treated as a token set or
 * copied into a host/guest auth file; Codex uses the opaque provider.cli
 * bridge in that mode. For raw-token paths, a durable local write is required,
 * while a stopped/not-yet-ready guest is recoverable: ensureCodexAuthFile()
 * retries the guest copy immediately before the next guest Codex turn.
 */
export async function prepareCodexAuthAfterExchange(
  tokens: Partial<OAuthTokenSet>,
  vaultOwned: boolean,
  linkIntoVm: () => Promise<boolean> = linkCodexHomeIntoVm,
): Promise<CodexAuthPreparationResult> {
  if (vaultOwned) return { custody: 'vault-bridge', written: false, linked: false };

  if (!writeCodexAuthFile(tokens)) {
    throw new Error('ChatGPT signed in, but its credentials could not be prepared locally');
  }

  return {
    custody: 'auth-file',
    written: true,
    linked:  await linkIntoVm(),
  };
}

/** Copy the exact Codex auth file into the guest-owned CLI home. */
export async function linkCodexHomeIntoVm(): Promise<boolean> {
  if (typeof process !== 'undefined' && process.type === 'renderer') return false;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
  const target = codexAuthPath();
  let staged: string | null = null;
  try {
    const { default: paths } = await import('@pkg/utils/paths');
    const { execFile } = await import('child_process');
    const env = { ...process.env };
    const guestExec = (args: string[]) => new Promise<string>((resolve, reject) => {
      execFile(paths.sullaRuntime, args, { env, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    if (fs.existsSync(codexRevocationPath())) {
      await removeGuestCodexAuthFile();
      return false;
    }
    staged = (await guestExec([
      'exec', '--', 'sh', '-c',
      'set -eu; umask 077; mktemp -d /tmp/sulla-codex-auth.XXXXXXXX',
    ])).trim();
    if (!/^\/tmp\/sulla-codex-auth\.[A-Za-z0-9]+$/.test(staged)) {
      throw new Error('Guest returned an invalid Codex auth staging path');
    }
    const incoming = `${ staged }/auth.json.incoming`;
    const hostAuthMtime = Math.trunc(fs.statSync(target).mtimeMs / 1_000);
    const script = [
      'set -eu',
      'stage="$1"',
      'incoming="$2"',
      'host_mtime="$3"',
      'd="$HOME/.codex"',
      'tmp=""',
      'cleanup() { rm -f -- "$incoming"; [ -z "$tmp" ] || rm -f -- "$tmp"; rmdir -- "$stage" 2>/dev/null || true; }',
      'trap cleanup EXIT HUP INT TERM',
      // Retire only the legacy link created by prior Sulla releases. `rm`
      // unlinks it and cannot traverse to or delete its host-side target.
      'if [ -L "$d" ]; then rm -- "$d"; fi',
      '[ ! -e "$d" ] || [ -d "$d" ]',
      'umask 077',
      'mkdir -p "$d"',
      '[ -d "$d" ] && [ "$(stat -c %u "$d")" = "$(id -u)" ]',
      'chmod 700 "$d"',
      // Once the homes are independent, Codex may have rotated the guest
      // refresh token. Compare against the host file's original timestamp,
      // rather than copy metadata that the copy transport may have changed.
      'if [ -f "$d/auth.json" ] && [ ! -L "$d/auth.json" ] && [ "$(stat -c %Y "$d/auth.json")" -ge "$host_mtime" ]; then exit 0; fi',
      'tmp=$(mktemp "$d/.auth.json.XXXXXXXX")',
      'install -m 600 "$incoming" "$tmp"',
      'mv -f -- "$tmp" "$d/auth.json"',
      'tmp=""',
    ].join('\n');
    await new Promise<void>((resolve, reject) => {
      execFile(paths.sullaRuntime, ['copy', target, `guest:${ incoming }`], {
        env,
        timeout: 30_000,
      }, err => (err ? reject(err) : resolve()));
    });
    await guestExec(['exec', '--', 'sh', '-c', script, 'sh', staged, incoming, String(hostAuthMtime)]);
    console.log('[codexAuthFile] VM ~/.codex/auth.json synchronized');
    firstRunTrace('codex', 'VM auth link completed', { success: true });
    return true;
  } catch (err) {
    if (staged && /^\/tmp\/sulla-codex-auth\.[A-Za-z0-9]+$/.test(staged)) {
      try {
        const { default: paths } = await import('@pkg/utils/paths');
        const { execFile } = await import('child_process');
        await new Promise<void>((resolve) => {
          execFile(paths.sullaRuntime, ['exec', '--', 'rm', '-rf', '--', staged!], {
            env: { ...process.env }, timeout: 30_000,
          }, () => resolve());
        });
      } catch { /* VM may have stopped during cleanup */ }
    }
    console.warn('[codexAuthFile] Could not link ~/.codex into the VM (VM not running?):', err);
    firstRunTrace('codex', 'VM auth link completed', { success: false, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Delete ~/.codex/auth.json — called when the codex integration is
 *  disconnected so the CLI stops authenticating with revoked credentials. */
export async function removeCodexAuthFile(): Promise<void> {
  fs.mkdirSync(codexHomeDir(), { recursive: true });
  const markerTemp = path.join(codexHomeDir(), `.auth.revoked.${ randomUUID() }`);
  try {
    fs.writeFileSync(markerTemp, 'revoked\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(markerTemp, codexRevocationPath());
  } finally {
    try { fs.unlinkSync(markerTemp) } catch { /* rename succeeded or write failed */ }
  }
  try {
    fs.unlinkSync(codexAuthPath());
  } catch { /* already gone */ }
  try {
    await removeGuestCodexAuthFile();
  } catch { /* VM may be stopped; host credential is already revoked. */ }
}

/** The UI's OAuth connect flow stores tokens under account id 'oauth'; older/headless flows use 'default'. */
async function resolveCodexAccountId(): Promise<string> {
  try {
    const { getIntegrationService } = await import('../services/IntegrationService');
    return await getIntegrationService().getActiveAccountId('codex');
  } catch {
    return 'oauth';
  }
}

/**
 * Pull a newer guest-rotated ~/.codex/auth.json back into host custody. The
 * CLI self-refreshes its own auth file in place inside the VM; without this,
 * a guest-side rotation is silently clobbered by a stale host copy on the
 * next ensure/link cycle (oauth-overhaul audit: "the guest Codex CLI and the
 * host scheduler can both rotate tokens without reconciling"). GuestAuthFile
 * is legacy custody only — never called when the vault authority owns the
 * token.
 */
export async function reconcileCodexAuthRotation(accountId: string): Promise<boolean> {
  if (typeof process !== 'undefined' && process.type === 'renderer') return false;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
  const marker = '---sulla-codex-auth---';
  try {
    const { default: paths } = await import('@pkg/utils/paths');
    const { execFile } = await import('child_process');
    const guestExec = (args: string[]) => new Promise<string>((resolve, reject) => {
      execFile(paths.sullaRuntime, args, { env: { ...process.env }, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const raw = await guestExec(['exec', '--', 'sh', '-c', [
      'set -eu',
      'f="$HOME/.codex/auth.json"',
      '[ -f "$f" ] || exit 0',
      'stat -c %Y "$f"',
      `echo ${ marker }`,
      'cat "$f"',
    ].join('\n')]);
    const splitAt = raw.indexOf(marker);
    if (splitAt === -1) return false;
    const guestMtime = Number(raw.slice(0, splitAt).trim());
    const guestJson = raw.slice(splitAt + marker.length).trim();
    if (!Number.isFinite(guestMtime) || !guestJson) return false;

    let hostMtime = 0;
    try { hostMtime = Math.trunc(fs.statSync(codexAuthPath()).mtimeMs / 1_000) } catch { /* no host copy yet */ }
    if (guestMtime <= hostMtime) return false;

    const parsed = JSON.parse(guestJson) as { tokens?: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown } };
    const accessToken = parsed.tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) return false;
    const tokens: OAuthTokenSet = {
      access_token:  accessToken,
      refresh_token: typeof parsed.tokens?.refresh_token === 'string' ? parsed.tokens.refresh_token : undefined,
      id_token:      typeof parsed.tokens?.id_token === 'string' ? parsed.tokens.id_token : undefined,
      token_type:    'Bearer',
      expires_at:    decodeJwtExpiry(accessToken) ?? undefined,
    };

    const { getOAuthService } = await import('../services/OAuthService');
    await getOAuthService().adoptTokens('codex', accountId, 'codex', tokens);
    console.log('[codexAuthFile] Imported guest-rotated Codex credentials back into custody');
    return true;
  } catch (err) {
    console.warn('[codexAuthFile] Could not reconcile guest Codex token rotation:', err);
    return false;
  }
}

/**
 * Make sure ~/.codex/auth.json exists, rebuilding it from the stored OAuth
 * token row when missing (fresh install, wiped home dir). The file is the
 * CLI's live store — when it already exists we leave it alone, since the CLI
 * may hold fresher tokens than the DB row.
 *
 * GuestAuthFile custody only. The container-vault authority never exports
 * raw OAuth credentials for Codex to write here — callers must resolve
 * ContainerBrokerLease (see codexExecutionAuth.ts) instead, so this returns
 * false rather than the "nothing to do, proceed" lie that let a guest spawn
 * without any real authentication (oauth-overhaul audit finding #1).
 */
export async function ensureCodexAuthFile(): Promise<boolean> {
  const { usesContainerVaultAuthority } = await import('../../vault-broker');
  if (usesContainerVaultAuthority()) return false;

  migrateLegacyCodexAuth();
  const accountId = await resolveCodexAccountId();
  await reconcileCodexAuthRotation(accountId);
  const exists = fs.existsSync(codexAuthPath());
  const fresh = exists && isAuthFileFresh();
  firstRunTrace('codex', 'auth file ensure started', { fileExists: exists, fresh });
  if (fresh) {
    const linked = await linkCodexHomeIntoVm();
    firstRunTrace('codex', 'auth file ensured', { source: 'host-file', linked });
    return linked;
  }
  try {
    const { getOAuthService } = await import('../services/OAuthService');
    const oauthService = getOAuthService();

    // Prefer the integration's active account when one is set.
    const accountIds = ['oauth', 'default'];
    if (accountId && !accountIds.includes(accountId)) accountIds.unshift(accountId);

    for (const candidateAccountId of accountIds) {
      try {
        const tokens = await oauthService.ensureFreshTokens('codex', candidateAccountId);
        if (writeCodexAuthFile(tokens)) {
          const linked = await linkCodexHomeIntoVm();
          firstRunTrace('codex', 'auth file ensured', { source: 'vault', accountId: candidateAccountId, linked });
          return linked;
        }
      } catch {
        const stored = await oauthService.getStoredTokens('codex', candidateAccountId);
        if (!stored?.raw_response) continue;
        const tokens = (typeof stored.raw_response === 'string'
          ? JSON.parse(stored.raw_response)
          : stored.raw_response) as OAuthTokenSet;
        if (writeCodexAuthFile(tokens) && isAuthFileFresh()) {
          return linkCodexHomeIntoVm();
        }
      }
    }
    return false;
  } catch (err) {
    console.warn('[codexAuthFile] Could not rebuild auth.json from stored tokens:', err);
    return false;
  }
}
