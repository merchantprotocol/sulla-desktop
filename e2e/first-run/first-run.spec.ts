// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer, type FakeMode } from './fakes';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Install = { app: ElectronApplication; page: Page; home: string; userData: string; statePath: string; fake: Awaited<ReturnType<typeof startFakeServer>>; output: string[]; urls: string[] };
const mainTracePath = (home: string) => path.join(home, 'sulla-e2e-main.log');
const expectedUserData = (home: string) => process.platform === 'darwin'
  ? path.join(home, 'Library/Application Support/sulla-desktop/electron')
  : path.join(home, '.local/share/sulla-desktop/electron');

async function diagnosticText(home: string, output: string[], urls: string[]) {
  const root = process.platform === 'darwin' ? path.join(home, 'Library/Logs/sulla-desktop') : path.join(home, '.local/share/sulla-desktop/logs');
  const files: string[] = [];
  const visit = async(dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(`--- ${ path.relative(root, file) } ---`, ...(await fs.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean));
    }
  };
  await visit(root);
  const trace = (await fs.readFile(mainTracePath(home), 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
  return [`Windows: ${ urls.join(', ') || '(none)' }`, 'Main-process startup trace:', ...(trace.length ? trace.slice(-40) : ['(none)']), 'Electron stdout/stderr:', ...output.slice(-80), 'Electron log files:', ...files.slice(-80)].join('\n');
}

async function launch(home?: string, mode: FakeMode = 'new-user', extra: Record<string, string> = {}): Promise<Install> {
  home ||= await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-first-run-'));
  const fake = await startFakeServer(mode);
  const output: string[] = []; const urls: string[] = [];
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, HOME: home, SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1', SULLA_E2E_OAUTH_URL: `${ fake.url }/oauth`, SULLA_E2E_VAULT_URL: `${ fake.url }/vault/write`, SULLA_E2E_MAIN_LOG: mainTracePath(home), ...extra } });
  const append = (chunk: Buffer | string) => output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  app.process().stdout?.on('data', append); app.process().stderr?.on('data', append);
  const remember = (candidate: Page) => { if (!urls.includes(candidate.url())) urls.push(candidate.url()); candidate.on('framenavigated', frame => { if (frame === candidate.mainFrame() && !urls.includes(frame.url())) urls.push(frame.url()); }); };
  app.windows().forEach(remember); app.on('window', remember);
  try {
    // Production Cloud auth intentionally has no configurable base URL. Install this
    // before any form submission, redirect only that exact origin, and fail closed.
    await app.evaluate((_, origin) => {
      const real = globalThis.fetch.bind(globalThis); const production = 'https://sulla-workers.merchantprotocol.workers.dev';
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => { const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const url = new URL(raw); if (url.origin === production) return real(`${ origin }${ url.pathname }${ url.search }`, init); if (url.origin === origin) return real(input, init); return Promise.reject(new Error(`E2E blocked unexpected network origin: ${ url.origin }`)); };
    }, fake.url);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const deadline = Date.now() + 30_000; let page: Page | undefined;
    while (!page && Date.now() < deadline) { page = app.windows().find(candidate => candidate.url().includes('FirstRun')); if (!page) await new Promise(resolve => setTimeout(resolve, 50)); }
    if (!page) throw new Error('Timed out after 30000ms waiting for the FirstRun route');
    return { app, page, home, userData, statePath: path.join(userData, 'first-run-state.json'), fake, output, urls };
  } catch (error) {
    const detail = await diagnosticText(home, output, urls);
    console.error(`::error title=Electron first-run window did not open::${ detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') }`);
    await app.close().catch(() => {}); await fake.close().catch(() => {});
    throw new Error(`${ error instanceof Error ? error.message : String(error) }\n${ detail }`);
  }
}
async function closeApp(app: ElectronApplication) {
  const child = app.process();
  const graceful = app.close().catch(() => {});
  await Promise.race([graceful, new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
}
async function close(i: Install) { await closeApp(i.app); await i.fake.close().catch(() => {}); }
async function waitForMainWindow(app: ElectronApplication) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = app.windows().find(candidate => !candidate.url().includes('FirstRun') && candidate.url() !== 'about:blank');
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out after 30000ms waiting for the main Sulla window');
}
async function state(i: Install) { return JSON.parse(await fs.readFile(i.statePath, 'utf8')); }
async function welcome(i: Install) { await i.page.getByRole('button', { name: /Get started/ }).click(); await expect(i.page.getByText('Create or connect your Sulla account')).toBeVisible(); }
async function enterAccount(i: Install) { await welcome(i); await i.page.locator('#email').fill('person@example.test'); await i.page.locator('form.fr-account-step').getByRole('button', { name: 'Continue', exact: true }).click(); await i.page.locator('#cloudPassword').fill('password123'); }
async function submitCloud(i: Install) { await i.page.locator('form.fr-account-step').getByRole('button', { name: /^(Continue|Retry|Create account and continue|Sign in and continue)$/ }).click(); }
async function reachAi(i: Install) { await enterAccount(i); await submitCloud(i); await i.page.getByRole('button', { name: 'Sync everything' }).click(); await expect(i.page.getByText('Connect the AI you already use.')).toBeVisible(); }
async function reachFinishing(i: Install) { await reachAi(i); await i.page.getByRole('button', { name: "I'll do this later" }).click(); await expect(i.page.getByText('Finishing setup')).toBeVisible(); await expect.poll(async() => (await state(i)).step).toBe(3); }
async function writeState(home: string, value: unknown) { const dir = expectedUserData(home); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'first-run-state.json'), `${ JSON.stringify(value) }\n`, { mode: 0o600 }); }

// Reaching Finishing completes the wizard, but credentialsSaved remains false
// until the real vault service is ready and is intentionally not faked here.
test('mandatory account reaches Finishing without pretending credentials are saved', async() => { const i = await launch(); try { await reachFinishing(i); expect(await state(i)).toMatchObject({ step: 3, onboardingComplete: true, credentialsSaved: false, choices: { accountChoice: 'cloud', cloudPreferences: { enabled: true } } }); expect(i.fake.requests.map(r => r.path)).toContain('/auth/email/register'); } finally { await close(i); } });
test('existing account falls back register 409 to prelogin and login', async() => { const i = await launch(undefined, 'existing-user'); try { await enterAccount(i); await submitCloud(i); await expect(i.page.getByText('Use Sulla on all your devices')).toBeVisible(); expect(i.fake.requests.map(r => r.path)).toEqual(expect.arrayContaining(['/auth/email/register', '/auth/prelogin', '/auth/email/login'])); } finally { await close(i); } });
test('auth failure retries once and advances without an extra register click', async() => { const i = await launch(undefined, 'auth-failure'); try { await enterAccount(i); await submitCloud(i); await expect(i.page.getByText(/Sulla Cloud had a problem|temporarily unavailable|Could not connect/i)).toBeVisible(); await submitCloud(i); await expect(i.page.getByText('Use Sulla on all your devices')).toBeVisible(); expect(i.fake.requests.filter(r => r.path === '/auth/email/register')).toHaveLength(2); } finally { await close(i); } });
test('OAuth success is synthetic and can advance', async() => { const i = await launch(); try { await reachAi(i); const row = i.page.locator('.frm-option').filter({ hasText: 'ChatGPT' }); await row.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(row.getByRole('button', { name: 'Connected', exact: true })).toBeVisible(); await i.page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect.poll(async() => (await state(i)).step).toBe(3); expect(i.fake.requests.map(r => r.path)).toContain('/oauth'); } finally { await close(i); } });
test('OAuth cancel is recoverable without running real OAuth', async() => { const i = await launch(undefined, 'new-user', { SULLA_E2E_OAUTH_RESULT: 'closed' }); try { await reachAi(i); const row = i.page.locator('.frm-option').filter({ hasText: 'ChatGPT' }); await row.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(i.page.getByText(/closed|cancelled/i)).toBeVisible(); await expect(row.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled(); } finally { await close(i); } });
test('API intent persists for post-setup vault Connect', async() => { const i = await launch(); try { await reachAi(i); await i.page.getByRole('button', { name: 'Connect through API instead' }).click(); await i.page.getByRole('button', { name: 'Use Claude API' }).click(); await i.page.getByRole('button', { name: "I'll do this later" }).click(); expect((await state(i)).choices.aiApiProvider).toBe('anthropic'); } finally { await close(i); } });
for (const [name, value, copy] of [['offline preflight', 'offline', 'could not reach the internet'], ['low-disk preflight', 'low-disk', 'needs at least 10 GB']] as const) test(name, async() => { const i = await launch(undefined, 'new-user', { SULLA_E2E_PREFLIGHT: value }); try { await i.page.getByRole('button', { name: /Get started/ }).click(); await expect(i.page.getByText(new RegExp(copy, 'i'))).toBeVisible(); expect((await state(i)).step).toBe(0); } finally { await close(i); } });
test('vault absence does not block reaching Finishing', async() => { const i = await launch(undefined, 'new-user', { SULLA_E2E_VAULT: 'absent' }); try { await reachFinishing(i); expect((await state(i)).credentialsSaved).toBe(false); } finally { await close(i); } });
test('current top-level steps resume according to the session contract', async() => { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-resume-')); try { await writeState(home, { version: 1, step: 1, onboardingComplete: false, choices: { sullaEmail: 'person@example.test' } }); let i = await launch(home); try { await expect(i.page.getByRole('status', { name: 'Picking up where you left off…' })).toBeHidden({ timeout: 15_000 }); await expect(i.page.locator('.fr-step.is-active')).toContainText('Account'); await expect(i.page.getByLabel('Email', { exact: true })).toHaveValue('person@example.test'); } finally { await close(i); } await writeState(home, { version: 1, step: 2, onboardingComplete: false, choices: { accountChoice: 'cloud', sullaEmail: 'person@example.test' } }); i = await launch(home); try { await expect(i.page.getByText('Enter your password again')).toBeVisible(); expect((await state(i)).step).toBe(1); } finally { await close(i); } await writeState(home, { version: 1, step: 3, onboardingComplete: false, credentialsSaved: false, choices: { accountChoice: 'cloud' } }); i = await launch(home); try { await expect(i.page.getByText('Finishing setup')).toBeVisible(); expect((await state(i)).step).toBe(3); } finally { await close(i); } } finally { await fs.rm(home, { recursive: true, force: true }); } });
test('completed wizard does not rerun', async() => { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-complete-')); const fake = await startFakeServer(); let app: ElectronApplication | undefined; try { await writeState(home, { version: 1, step: 3, onboardingComplete: true, credentialsSaved: true, choices: {} }); app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, HOME: home, SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1', SULLA_E2E_MAIN_LOG: mainTracePath(home) } }); await waitForMainWindow(app); expect(app.windows().some(page => page.url().includes('FirstRun'))).toBe(false); } finally { if (app) await closeApp(app); await fake.close(); await fs.rm(home, { recursive: true, force: true }); } });
test('legacy fixture without vault skips wizard only with durable fallback marker', async() => { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-upgrade-')); const fake = await startFakeServer(); let app: ElectronApplication | undefined; try { const dir = expectedUserData(home); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'sulla-settings-fallback.json'), JSON.stringify({ firstRunCredentialsNeeded: false })); app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, HOME: home, SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1', SULLA_E2E_MAIN_LOG: mainTracePath(home) } }); const actual = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')); expect(actual).toBe(dir); await waitForMainWindow(app); expect(app.windows().some(page => page.url().includes('FirstRun'))).toBe(false); const saved = JSON.parse(await fs.readFile(path.join(actual, 'first-run-state.json'), 'utf8')); expect(saved.onboardingComplete).toBe(true); expect(await fs.readdir(actual)).not.toContain('vault-control-token.enc'); } finally { if (app) await closeApp(app); await fake.close(); await fs.rm(home, { recursive: true, force: true }); } });
