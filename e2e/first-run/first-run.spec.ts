// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer, type FakeMode } from './fakes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Install = { app: ElectronApplication; page: Page; home: string; statePath: string; fake: Awaited<ReturnType<typeof startFakeServer>> };
async function diagnosticText(home: string, lines: string[], urls: string[]): Promise<string> {
  const logRoot = process.platform === 'darwin' ? path.join(home, 'Library/Logs/sulla-desktop') : path.join(home, '.local/share/sulla-desktop/logs');
  const fileLines: string[] = [];
  const visit = async(directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) {
        const content = await fs.readFile(candidate, 'utf8').catch(() => '');
        if (content) fileLines.push(`--- ${ path.relative(logRoot, candidate) } ---`, ...content.split(/\r?\n/).filter(Boolean));
      }
    }
  };
  await visit(logRoot);
  return [`Windows: ${ urls.length ? urls.join(', ') : '(none)' }`, 'Electron stdout/stderr:', ...lines.slice(-80), 'Electron log files:', ...fileLines.slice(-80)].join('\n');
}
async function launch(home?: string, mode: FakeMode = 'new-user', extra: Record<string,string> = {}): Promise<Install> {
  home ||= await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-first-run-'));
  const fake = await startFakeServer(mode);
  const output: string[] = [];
  const urls: string[] = [];
  const append = (chunk: Buffer | string) => output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  const app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '../..'), env: { ...process.env, HOME: home, SULLA_E2E: '1', SULLA_MOCK_BACKEND: '1', SULLA_E2E_CLOUD_URL: fake.url, SULLA_E2E_OAUTH_URL: `${fake.url}/oauth`, SULLA_E2E_VAULT_URL: `${fake.url}/vault/write`, ...extra } });
  app.process().stdout?.on('data', append);
  app.process().stderr?.on('data', append);
  const remember = (candidate: Page) => {
    const url = candidate.url();
    if (!urls.includes(url)) urls.push(url);
    candidate.on('framenavigated', frame => {
      if (frame === candidate.mainFrame() && !urls.includes(frame.url())) urls.push(frame.url());
    });
  };
  app.windows().forEach(remember);
  app.on('window', remember);
  try {
    // BrowserWindow is emitted while its URL is still about:blank, so a window
    // event predicate sees the pre-navigation URL once and never matches. Poll
    // the live windows until the renderer has navigated to the FirstRun route.
    const deadline = Date.now() + 30_000;
    let page: Page | undefined;
    while (!page && Date.now() < deadline) {
      page = app.windows().find(candidate => candidate.url().includes('FirstRun'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!page) throw new Error('Timed out after 30000ms waiting for the FirstRun route');
    const statePath = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/sulla-desktop/electron/first-run-state.json') : path.join(home, '.local/share/sulla-desktop/electron/first-run-state.json');
    return { app, page, home, statePath, fake };
  } catch (error) {
    const detail = await diagnosticText(home, output, urls);
    console.error(`::error title=Electron first-run window did not open::${ detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') }`);
    await app.close().catch(() => {});
    await fake.close().catch(() => {});
    throw new Error(`${ error instanceof Error ? error.message : String(error) }\n${ detail }`);
  }
}
async function state(i: Install) { return JSON.parse(await fs.readFile(i.statePath, 'utf8')); }
async function welcome(i: Install) { await i.page.getByRole('button', { name: /Get started/ }).click(); await expect(i.page.getByText('Create your Sulla account')).toBeVisible(); expect((await state(i)).step).toBe(1); }
async function macOnly(i: Install) { await welcome(i); await i.page.getByRole('button', { name: 'Continue without an account' }).click(); await i.page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(i.page.getByText('Connect the AI you already use.')).toBeVisible(); }
async function finishLater(i: Install) { await macOnly(i); await i.page.getByRole('button', { name: "I'll do this later" }).click(); await i.page.getByRole('button', { name: "I'll explore on my own" }).click(); await expect.poll(async() => (await state(i)).onboardingComplete).toBe(true); }
async function close(i: Install) { await i.app.close().catch(() => {}); await i.fake.close().catch(() => {}); }

test('happy path Cloud + Claude', async() => { const i=await launch(); try { await welcome(i); await i.page.locator('#email').fill('person@example.test'); await i.page.getByRole('button',{name:'Continue',exact:true}).click(); await i.page.locator('#cloudPassword').fill('password123'); await i.page.getByRole('button',{name:/Create account/}).click(); await i.page.getByRole('button',{name:'Continue',exact:true}).click(); await i.page.getByRole('button',{name:'Connect',exact:true}).first().click(); await expect(i.page.getByText(/connected/i)).toBeVisible(); } finally { await close(i); } });
test("This Mac only + I'll do this later", async()=>{const i=await launch();try{await finishLater(i);expect(await state(i)).toMatchObject({step:0,onboardingComplete:true,choices:{accountChoice:'mac-only'}});}finally{await close(i);}});
test('quit at every top-level step resumes and completion never reruns', async()=>{let i=await launch();const home=i.home;try{await welcome(i);expect((await state(i)).step).toBe(1);await close(i);i=await launch(home);await expect(i.page.getByText('Create your Sulla account')).toBeVisible();await i.page.getByRole('button',{name:'Continue without an account'}).click();await i.page.getByRole('button',{name:'Continue',exact:true}).click();await close(i);i=await launch(home);await expect(i.page.getByText('Connect the AI you already use.')).toBeVisible();await i.page.getByRole('button',{name:"I'll do this later"}).click();await close(i);i=await launch(home);await expect(i.page.getByText('What should Sulla take off your plate first?')).toBeVisible();await i.page.getByRole('button',{name:"I'll explore on my own"}).click();await expect.poll(async()=> (await state(i)).onboardingComplete).toBe(true);await close(i);i=await launch(home);await expect(i.page.getByText('Create your Sulla account')).toHaveCount(0);}finally{await close(i);await fs.rm(home,{recursive:true,force:true});}});
test('close-window confirm keeps setup open',async()=>{const i=await launch();try{await welcome(i);const dialog=i.app.waitForEvent('window').catch(()=>null);await i.page.close({runBeforeUnload:true}).catch(()=>{});expect((await state(i)).onboardingComplete).toBe(false);void dialog;}finally{await close(i);}});
test('existing Cloud user signs in',async()=>{const i=await launch(undefined,'existing-user');try{await welcome(i);await i.page.locator('#email').fill('person@example.test');await i.page.getByRole('button',{name:'Continue',exact:true}).click();await i.page.locator('#cloudPassword').fill('password123');await i.page.getByRole('button',{name:/Create account/}).click();await expect(i.page.getByText('Choose what syncs')).toBeVisible();}finally{await close(i);}});
test('Cloud timeout can be abandoned for Mac-only',async()=>{const i=await launch(undefined,'timeout');try{await welcome(i);await i.page.locator('#email').fill('person@example.test');await i.page.getByRole('button',{name:'Continue',exact:true}).click();await i.page.locator('#cloudPassword').fill('password123');void i.page.getByRole('button',{name:/Create account/}).click();await i.page.getByRole('button',{name:'This Mac only, for now'}).click();await expect(i.page.getByText('Choose what syncs')).toBeVisible();}finally{await close(i);}});
test('Cloud down leaves Mac-only usable',async()=>{const i=await launch(undefined,'error');try{await welcome(i);await i.page.locator('#email').fill('person@example.test');await i.page.getByRole('button',{name:'Continue',exact:true}).click();await i.page.locator('#cloudPassword').fill('password123');await i.page.getByRole('button',{name:/Create account/}).click();await expect(i.page.getByText(/Could not|unavailable/)).toBeVisible();await i.page.getByRole('button',{name:'This Mac only, for now'}).click();await expect(i.page.getByText('Choose what syncs')).toBeVisible();}finally{await close(i);}});
test('OAuth close retries once then leaves usable error',async()=>{const i=await launch(undefined,'new-user',{SULLA_E2E_OAUTH_RESULT:'closed'});try{await macOnly(i);await i.page.getByRole('button',{name:'Connect',exact:true}).first().click();await expect(i.page.getByText(/still didn't finish signing in/)).toBeVisible({timeout:10_000});await expect(i.page.getByRole('button',{name:'Connect',exact:true}).first()).toBeEnabled();}finally{await close(i);}});
test('vault absent during setup does not block completion',async()=>{const i=await launch(undefined,'new-user',{SULLA_E2E_VAULT:'absent'});try{await finishLater(i);expect((await state(i)).onboardingComplete).toBe(true);}finally{await close(i);}});
test('API intent persists for post-setup vault Connect',async()=>{const i=await launch();try{await macOnly(i);await i.page.getByRole('button',{name:'Connect through API instead'}).click();await i.page.getByRole('button',{name:'Use Claude API'}).click();expect((await state(i)).choices.aiApiProvider).toBe('anthropic');}finally{await close(i);}});
for(const [name,value,copy] of [['offline preflight','offline','could not reach the internet'],['low-disk preflight','low-disk','needs at least 10 GB']] as const)test(name,async()=>{const i=await launch(undefined,'new-user',{SULLA_E2E_PREFLIGHT:value});try{await i.page.getByRole('button',{name:/Get started/}).click();await expect(i.page.getByText(new RegExp(copy,'i'))).toBeVisible();expect((await state(i)).step).toBe(0);}finally{await close(i);}});
test('upgrade with existing vault files skips wizard',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'sulla-upgrade-'));const vault=process.platform==='darwin'?path.join(home,'Library/Application Support/sulla-desktop/vault-control-token.enc'):path.join(home,'.local/share/sulla-desktop/vault-control-token.enc');await fs.mkdir(path.dirname(vault),{recursive:true});await fs.writeFile(vault,'existing');const fake=await startFakeServer();const app=await electron.launch({args:['.'],cwd:path.resolve(__dirname,'../..'),env:{...process.env,HOME:home,SULLA_E2E:'1',SULLA_MOCK_BACKEND:'1',SULLA_E2E_CLOUD_URL:fake.url}});try{await new Promise(resolve=>setTimeout(resolve,2000));expect(app.windows().some(page=>page.url().includes('FirstRun'))).toBe(false);const statePath=process.platform==='darwin'?path.join(home,'Library/Application Support/sulla-desktop/electron/first-run-state.json'):path.join(home,'.local/share/sulla-desktop/electron/first-run-state.json');expect(JSON.parse(await fs.readFile(statePath,'utf8')).onboardingComplete).toBe(true);}finally{await app.close().catch(()=>{});await fake.close();await fs.rm(home,{recursive:true,force:true});}});
