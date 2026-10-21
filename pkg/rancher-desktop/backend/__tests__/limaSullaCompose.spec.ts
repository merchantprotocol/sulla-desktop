/** @jest-environment node */
// Drives the real LimaBackend.prepareSullaComposeFile() with the VM and the
// app's services faked, then inspects the compose file it would write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import yaml from 'yaml';

const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-lima-compose-'));
const assetCompose = yaml.parse(fs.readFileSync(path.resolve('pkg/rancher-desktop/assets/sulla-docker-compose.yaml'), 'utf8'));
// All '@pkg/assets/*' imports resolve to one stub, so the stub carries the
// compose definition plus the dependency versions lima.ts reads at load.
const assetStub: any = { alpineLimaISO: { isoVersion: '0', alpineVersion: '0' } };
const flags = { vaultV2: false, fuse: false };
// The guest's /proc/self/mountinfo; BusyBox Alpine has no usable findmnt.
const guest = { mountinfo: '22 1 0:20 / / rw,relatime shared:1 - tmpfs tmpfs rw\n', catFails: false };
const mountReports: (string | undefined)[] = [];
const noop = () => undefined;
const stubs = (names: string, extra: Record<string, unknown> = {}) => ({
  ...Object.fromEntries(names.split(' ').map(name => [name, noop])), ...extra,
});

jest.unstable_mockModule('@pkg/assets/sulla-docker-compose.yaml', () => ({ default: assetStub }));
jest.unstable_mockModule('electron', () => {
  const any: any = new Proxy(function() {}, { get: (_t, key) => key === 'then' ? undefined : any, apply: () => any, construct: () => any });
  const app = { getVersion: () => '1.6.1', isPackaged: true, getPath: () => appHome, on: noop, whenReady: () => Promise.resolve() };
  const names = 'BaseWindow BrowserView BrowserWindow MessageChannelMain Menu MenuItem Notification Tray WebContentsView ' +
    'autoUpdater clipboard contextBridge crashReporter desktopCapturer dialog globalShortcut ipcMain ipcRenderer ' +
    'nativeImage nativeTheme net powerMonitor powerSaveBlocker protocol safeStorage screen session shell ' +
    'systemPreferences utilityProcess webContents webFrame';
  const exports: Record<string, unknown> = Object.fromEntries(names.split(' ').map(name => [name, any]));

  return { ...exports, app, default: { ...exports, app } };
});
jest.unstable_mockModule('@pkg/agent/database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { getServicePassword: () => Promise.resolve('service-pass$word'), get: () => Promise.resolve('') },
}));
jest.unstable_mockModule('@pkg/config/settingsImpl', () => stubs(
  'SETTING clearSettings createSettings determineLockedFields firstRunDialogNeeded getDefaultMemory getLockedSettings ' +
  'load merge migrateSpecifiedSettingsToCurrentVersion runInDebugMode save turnFirstRunOff updateLockedFields updateTable',
  { getSettings: () => ({ experimental: { sullaVaultV2Enabled: flags.vaultV2 } }) },
));
jest.unstable_mockModule('@pkg/utils/paths', () => ({
  default: new Proxy({ appHome }, { get: (target: any, key) => target[key] ?? appHome }),
}));
jest.unstable_mockModule('@pkg/utils/sullaFilesNativeSource', () => ({
  sullaFilesNativeSourceRolloutRequested: () => flags.fuse,
}));
jest.unstable_mockModule('@pkg/main/vaultTls', () => ({ VAULT_HTTPS_ORIGIN: 'https://127.0.0.1:30135', refreshVaultPinnedSessions: () => Promise.resolve() }));
jest.unstable_mockModule('@pkg/main/sullaFilesTls', () => ({
  FILES_HTTPS_ORIGIN:           'https://127.0.0.1:30124',
  refreshFilesPinnedSessions:   () => Promise.resolve(),
  desktopFilesFetch:            () => Promise.resolve(new Response('{}')),
}));
jest.unstable_mockModule('@pkg/main/sullaFilesMountManager', () => stubs('SullaFilesMountManager', {
  getSullaFilesMountManager: () => ({
    reportGuestPreparation: (reason?: string) => { mountReports.push(reason) },
    guestMountAvailable:    () => mountReports.length > 0 && mountReports[mountReports.length - 1] === undefined,
  }),
}));
jest.unstable_mockModule('@pkg/main/mainEvents', () => stubs('NoMainEventsHandlerError', {
  default: { on: noop, emit: noop, handle: noop, invoke: noop },
}));
jest.unstable_mockModule('@pkg/main/deploymentProfiles', () => stubs('DeploymentProfileError readDeploymentProfiles validateDeploymentProfile'));
jest.unstable_mockModule('@pkg/main/credentialServer/httpCredentialHelperServer', () => ({
  getServerCredentialsPath: () => '', ServerState: {},
}));
jest.unstable_mockModule('@pkg/sulla', () => stubs('afterBackgroundLoaded expectVaultContainer hookSullaEnd initiateWindowContext ' +
  'instantiateSullaStart markSullaDockerServicesStarted markVaultContainerReady onMainProxyLoad sullaEnd'));
jest.unstable_mockModule('@pkg/window', () => stubs('centerDialog closeExtension createWindow getWindow openAudioSettings ' +
  'openCaptureStudio openDenyRootDialog openDialog openDockerDashboard openExtension ' +
  'openFirstRunDialog openKubernetesErrorMessageWindow openLanguageModelSettings openMain openSudoPrompt ' +
  'openUnmetPrerequisitesDialog openUpdatesWindow openUrlInApp restoreWindow send showMessageBox webRoot windowMapping'));
jest.unstable_mockModule('@pkg/sudo-prompt', () => ({ exec: noop }));

const { default: LimaBackend } = await import('../lima');
const { ACCOUNTS_SECRETS_DIRECTORY, findHostBindMounts } = await import('../sullaComposeMounts');

interface Recorded { command: string[]; options: any }

function fakeBackend() {
  const backend: any = new LimaBackend('x86_64' as any, () => ({}) as any);
  const commands: Recorded[] = [];
  const copies: [string, string][] = [];
  let written = '';

  backend.execCommand = (...args: any[]) => {
    const options = typeof args[0] === 'object' ? args.shift() : {};

    commands.push({ command: args, options });

    if (args[0] === 'mktemp') return Promise.resolve('/tmp/sulla-accounts-secrets.Test01\n');
    if (args[0] === 'findmnt') return Promise.reject(new Error('limactl exited with code 1'));
    if (args[0] === 'cat' && args[1] === '/proc/self/mountinfo') {
      return guest.catFails ? Promise.reject(new Error('cat failed')) : Promise.resolve(guest.mountinfo);
    }
    if (args[0] === 'mount' && args[1] === '--bind' && args[2] === '/mnt/sulla-files') {
      guest.mountinfo += '612 22 0:20 /mnt/sulla-files /mnt/sulla-files rw,relatime shared:300 - tmpfs tmpfs rw\n';
    }

    return Promise.resolve('');
  };
  backend.lima = (...args: string[]) => { copies.push([args[1], args[2]]); return Promise.resolve() };
  backend.writeFile = (file: string, contents: string) => {
    if (file === '/tmp/sulla-docker-compose.yml') written = contents;

    return Promise.resolve();
  };
  backend.prepareFilesTlsIdentity = () => Promise.resolve({ fingerprint: 'files-fp' });
  backend.prepareVaultTlsIdentity = () => Promise.resolve({ fingerprint: 'vault-fp' });
  backend.loadOrCreateFilesBootstrapIdentity = () => Promise.resolve('files-bootstrap');
  backend.loadOrCreateVaultServiceIdentities = () => Promise.resolve({
    bootstrapToken: 'b', controlToken: 'c', approvalToken: 'a', brokerToken: 'k', filesToken: 'f',
  });

  return { backend, commands, copies, compose: () => yaml.parse(written) };
}

async function generate() {
  const { backend, commands, copies, compose } = fakeBackend();

  await backend.prepareSullaComposeFile();

  return { compose: compose(), commands, copies };
}

function volumeSource(volume: any): string | undefined {
  if (typeof volume !== 'string') return volume.type === 'volume' ? undefined : volume.source;
  const [source, target] = volume.split(':');

  const isPath = ['/', '.', '~', '{'].some(prefix => source.startsWith(prefix));

  // "target" alone is anonymous; "name:target" is a named volume.
  return target !== undefined && isPath ? source : undefined;
}

beforeAll(() => {
  fs.writeFileSync(path.join(appHome, 'chat-api-token.json'), JSON.stringify({ token: 'api-token' }));
});
afterAll(() => { fs.rmSync(appHome, { recursive: true, force: true }) });
beforeEach(() => {
  const fresh = structuredClone(assetCompose);

  for (const key of Object.keys(assetStub)) if (key !== 'alpineLimaISO') delete assetStub[key];
  Object.assign(assetStub, fresh);
  guest.mountinfo = '22 1 0:20 / / rw,relatime shared:1 - tmpfs tmpfs rw\n';
  guest.catFails = false;
  mountReports.length = 0;
});

describe.each([
  { vaultV2: false, fuse: false },
  { vaultV2: true, fuse: true },
])('generated Sulla compose (vault v2: $vaultV2, files fuse: $fuse)', (scenario) => {
  beforeEach(() => { Object.assign(flags, scenario) });

  test('no service binds a host path; every bind is a guest-local path', async() => {
    const { compose } = await generate();
    const home = os.homedir();
    const services = Object.keys(compose.services);

    expect(services).toEqual(expect.arrayContaining(['postgres', 'redis', 'sulla_accounts', 'sulla_files', 'tools']));
    if (scenario.vaultV2) expect(services).toContain('sulla_vault');
    if (scenario.fuse) expect(services).toContain('sulla_files_fuse');
    expect(findHostBindMounts(compose)).toEqual([]);
    for (const [name, service] of Object.entries<any>(compose.services)) {
      for (const volume of service.volumes ?? []) {
        const source = volumeSource(volume);

        if (source === undefined) continue; // named volume
        expect({ name, source }).toEqual({ name, source: expect.stringMatching(/^\/(mnt\/data\/|var\/lib\/sulla\/|mnt\/sulla-files$|mnt\/sulla-backups$|proc$|var\/run\/docker\.sock$)/) });
        expect(source.startsWith(appHome)).toBe(false);
        expect(source.startsWith(home)).toBe(false);
        expect(source.startsWith('/Users')).toBe(false);
      }
    }
  });

  test('accounts reads its secrets from the guest copy, which Desktop provisions', async() => {
    const { compose, commands, copies } = await generate();
    const accountsVolumes = compose.services.sulla_accounts.volumes;

    expect(accountsVolumes.map((v: any) => v.source)).toEqual(
      ['database.username', 'database.password', 'bootstrap.secret', 'session.secret', 'encryption.key']
        .map(name => `${ ACCOUNTS_SECRETS_DIRECTORY }/${ name }`));
    // Values come from the host value store under appHome, copied into staging.
    expect(copies.map(([hostPath]) => path.dirname(hostPath))).toEqual(Array(5).fill(path.join(appHome, 'accounts')));
    expect(copies.every(([, guest]) => guest.startsWith('0:/tmp/sulla-accounts-secrets.Test01/'))).toBe(true);
    const install = commands.find(c => c.command[0] === 'sh' && c.command.includes(ACCOUNTS_SECRETS_DIRECTORY));

    expect(install?.options.root).toBe(true);
  });

  test('Files mounts /data/files explicitly so a stale inherited bind is replaced', async() => {
    const { compose } = await generate();

    expect(compose.services.sulla_files.volumes).toContain('sulla-files-folder:/data/files');
    expect(compose.volumes).toHaveProperty('sulla-files-folder');
  });

  test('workflow manager command names the interpreter after the setpriv entrypoint', async() => {
    const { compose } = await generate();

    expect(compose.services.workflow_manager.command).toEqual(['node', 'dist/services/sulla-workflows/src/manager.js']);
  });
});

describe('guest Files mount preparation never blocks compose generation', () => {
  beforeEach(() => { Object.assign(flags, { vaultV2: false, fuse: true }) });
  const filesBinds = (compose: any) => Object.entries<any>(compose.services)
    .filter(([, service]) => (service.volumes ?? []).some((v: any) => typeof v === 'string' && v.startsWith('/mnt/sulla-files:')))
    .map(([name]) => name).sort();

  test('BusyBox guest without findmnt: binds once, makes shared, keeps the adapter', async() => {
    const { compose, commands } = await generate();
    const mounts = commands.filter(c => c.command[0] === 'mount').map(c => c.command.join(' ')).filter(c => !c.includes('/mnt/sulla-backups'));

    expect(mounts).toEqual(['mount --bind /mnt/sulla-files /mnt/sulla-files', 'mount --make-shared /mnt/sulla-files']);
    expect(compose.services).toHaveProperty('sulla_files_fuse');
    expect(filesBinds(compose)).toEqual(['sulla_files_fuse', 'workflow_manager']);
    expect(mountReports).toEqual([undefined]);
    expect(compose.services.workflow_manager.environment.SULLA_FILES_GUEST_MOUNT).toBe('1');
  });

  test.each([
    ['an unexpected FUSE mount', () => { guest.mountinfo += '720 22 0:61 / /mnt/sulla-files rw - fuse.sshfs u@h:/x rw\n' }, /Refusing to reuse/],
    ['an unreadable mount table', () => { guest.catFails = true }, /cat failed/],
  ])('%s: omits the adapter and its binds, reports, and still writes compose', async(_label, arrange, reason) => {
    arrange();
    const { compose, commands } = await generate();

    expect(compose.services).not.toHaveProperty('sulla_files_fuse');
    expect(compose.services).toHaveProperty('sulla_files');
    expect(filesBinds(compose)).toEqual([]);
    expect(commands.some(c => c.command[0] === 'mount' && c.command.includes('/mnt/sulla-files'))).toBe(false);
    expect(compose.services.workflow_manager.environment).not.toHaveProperty('SULLA_FILES_GUEST_MOUNT');
    expect(mountReports).toEqual([expect.stringMatching(reason)]);
  });
});

describe('runtime recovery of the guest Files mount', () => {
  beforeEach(() => { Object.assign(flags, { vaultV2: false, fuse: true }) });

  test('recoverSullaFilesGuestMount restores the adapter, the consumer bind and marker, and recreates workflow_manager', async() => {
    const foreign = '720 22 0:61 / /mnt/sulla-files rw - fuse.sshfs u@h:/x rw\n';
    const { backend, commands, compose } = fakeBackend();

    guest.mountinfo += foreign;
    await backend.prepareSullaComposeFile();
    expect(compose().services).not.toHaveProperty('sulla_files_fuse');
    expect(compose().services.workflow_manager.environment).not.toHaveProperty('SULLA_FILES_GUEST_MOUNT');

    // The foreign mount goes away; a retry re-runs the same preparation.
    guest.mountinfo = guest.mountinfo.replace(foreign, '');
    commands.length = 0;
    await backend.recoverSullaFilesGuestMount();
    const recovered = compose();

    expect(recovered.services).toHaveProperty('sulla_files_fuse');
    expect(recovered.services.workflow_manager.volumes).toContain('/mnt/sulla-files:/mnt/sulla-files:rslave');
    expect(recovered.services.workflow_manager.environment.SULLA_FILES_GUEST_MOUNT).toBe('1');
    expect(commands.map(c => c.command.join(' '))).toEqual(expect.arrayContaining([
      'mount --bind /mnt/sulla-files /mnt/sulla-files',
      'mount --make-shared /mnt/sulla-files',
      'docker compose -f /tmp/sulla-docker-compose.yml -p sulla up -d --no-deps workflow_manager',
    ]));
    expect(mountReports).toEqual([expect.stringMatching(/Refusing to reuse/), undefined]);
  });

  test('recoverSullaFilesGuestMount throws while preparation still fails, without touching consumers', async() => {
    const { backend, commands } = fakeBackend();

    guest.catFails = true;
    await expect(backend.recoverSullaFilesGuestMount()).rejects.toThrow(/cat failed/);
    expect(commands.some(c => c.command.includes('workflow_manager'))).toBe(false);
  });
});
