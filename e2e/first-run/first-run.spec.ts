// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { startFakeServer, type FakeMode } from './fakes';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Install = { app: ElectronApplication; page: Page; home: string; statePath: string; fake: Awaited<ReturnType<typeof startFakeServer>> };
const userData = (home: string) => path.join(home, '.local/share/sulla-desktop/electron');
async function launch(home: string | undefined = undefined, mode: FakeMode = 'new-user'): Promise<Install> {
  home ||= await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-first-run-'));
  const fake = await startFakeServer(mode);
  const app = await electron.launch({ args: ['--sulla-test-instance', '.'], cwd: repoRoot, env: { ...process.env, HOME: home, SULLA_INSTANCE: 'firstrun-test', SULLA_TEST_AUTOPILOT: '', SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1' } });
  // Auth's production endpoint is intentionally not configurable. Redirect only that
  // host to our loopback fixture, and fail closed for every other network request.
  await app.evaluate((_, origin) => {
    const real = globalThis.fetch.bind(globalThis); const production = 'https://sulla-workers.merchantprotocol.workers.dev';
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => { const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const u = new URL(raw); if (u.origin === production) return real(`${origin}${u.pathname}${u.search}`, init); if (u.origin === origin) return real(input, init); return Promise.reject(new Error(`E2E blocked unexpected network origin: ${u.origin}`)); };
  }, fake.url);
  const deadline = Date.now() + 30_000; let page: Page | undefined;
  while (!page && Date.now() < deadline) { page = app.windows().find(candidate => candidate.url().includes('FirstRun')); if (!page) await new Promise(resolve => setTimeout(resolve, 50)); }
  if (!page) { await app.close(); await fake.close(); throw new Error('Timed out waiting for FirstRun route'); }
  return { app, page, home, statePath: path.join(userData(home), 'first-run-state.json'), fake };
}
async function state(i: Install) { return JSON.parse(await fs.readFile(i.statePath, 'utf8')); }
async function close(i: Install) { await i.app.close().catch(() => {}); await i.fake.close().catch(() => {}); }
async function account(i: Install) { await i.page.getByRole('button', { name: /Get started/ }).click(); await i.page.locator('#email').fill('person@example.test'); await i.page.getByRole('button', { name: 'Continue', exact: true }).click(); await i.page.locator('#cloudPassword').fill('password123'); }
async function finish(i: Install) { await i.page.getByRole('button', { name: 'Create account and continue' }).click(); await i.page.getByRole('button', { name: 'Sync everything' }).click(); await i.page.getByRole('button', { name: "I'll do this later" }).click(); await expect.poll(async () => (await state(i)).step).toBe(3); }

test('mandatory account flow uses synthetic Cloud and reaches Finishing', async () => { const i = await launch(); try { await account(i); await finish(i); expect((await state(i)).choices).toMatchObject({ accountChoice: 'cloud', cloudPreferences: { enabled: true } }); expect(i.fake.requests.map(r => r.path)).toEqual(expect.arrayContaining(['/auth/email/register'])); } finally { await close(i); } });
test('account flow resumes after quit without rerunning Welcome', async () => { const i = await launch(); const home = i.home; try { await i.page.getByRole('button', { name: /Get started/ }).click(); await i.page.locator('#email').fill('person@example.test'); await i.page.getByRole('button', { name: 'Continue', exact: true }).click(); expect((await state(i)).step).toBe(1); await close(i); const resumed = await launch(home); try { await expect(resumed.page.getByText('Choose your account password')).toBeVisible(); expect((await state(resumed)).onboardingComplete).toBe(false); } finally { await close(resumed); } } finally { await fs.rm(home, { recursive: true, force: true }); } });
test('auth failure is recoverable and does not contact production Cloud', async () => { const i = await launch(undefined, 'auth-failure'); try { await account(i); await i.page.getByRole('button', { name: 'Create account and continue' }).click(); await expect(i.page.getByText(/temporarily unavailable|Could not connect/i)).toBeVisible(); await i.page.getByRole('button', { name: /Create account and continue/ }).click(); await finish(i); expect(i.fake.requests.filter(r => r.path === '/auth/email/register')).toHaveLength(2); } finally { await close(i); } });
test('upgrade fixture without vault has no secret disk and skips wizard only with fallback marker', async () => { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-upgrade-')); const dir = userData(home); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'sulla-settings-fallback.json'), JSON.stringify({ firstRunCredentialsNeeded: false })); const fake = await startFakeServer(); const app = await electron.launch({ args: ['--sulla-test-instance', '.'], cwd: repoRoot, env: { ...process.env, HOME: home, SULLA_INSTANCE: 'firstrun-test', SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1' } }); try { await expect.poll(async () => (await fs.readFile(path.join(dir, 'first-run-state.json'), 'utf8').then(JSON.parse)).onboardingComplete).toBe(true); expect(app.windows().some(page => page.url().includes('FirstRun'))).toBe(false); expect(await fs.readdir(dir)).not.toContain('vault-control-token.enc'); } finally { await app.close().catch(() => {}); await fake.close(); await fs.rm(home, { recursive: true, force: true }); } });
