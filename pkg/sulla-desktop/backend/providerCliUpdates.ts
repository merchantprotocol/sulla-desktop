// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getGuestRuntimeIdentity } from '@pkg/agent/services/GuestRuntimeTransport';
import { getCliStatus, CLI_PROVIDERS } from '@pkg/agent/tools/models/shared';
import { runCommand } from '@pkg/agent/tools/util/CommandRunner';
import {
  PROVIDER_CLI_IDS, VERSIONED_PROVIDER_CLI_IDS, providerCliContainerSettings, providerCliPrefix,
  providerCliSnapshotForSelection, type ProviderCliSnapshot,
} from '@pkg/shared/providerCliSelection';
import { assertConfirmedCliUpdate } from '@pkg/shared/providerCliUpdateAuthority';

const PACKAGES: Record<(typeof VERSIONED_PROVIDER_CLI_IDS)[number], string> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex:         '@openai/codex',
};
const SETTING = 'approvedProviderCliVersions';
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const SAFE_IMAGE_COMMANDS = new Set<string>(VERSIONED_PROVIDER_CLI_IDS);
let updateInFlight = false;

export type ProviderCliUpdateStage =
  | 'prepare'
  | 'existing-lock-audit'
  | 'existing-binary-check'
  | 'worker-abi'
  | 'dependency-lock'
  | 'dependency-audit'
  | 'dependency-install'
  | 'native-materialization'
  | 'staged-binary-check'
  | 'worker-smoke'
  | 'activation'
  | 'timeout'
  | 'unknown';

const UPDATE_STAGE_LABELS: Readonly<Record<ProviderCliUpdateStage, string>> = {
  prepare:                 'preparing the worker update',
  'existing-lock-audit':   'auditing the existing locked package',
  'existing-binary-check': 'checking the selected CLI executable',
  'worker-abi':            'checking the actual worker image ABI',
  'dependency-lock':       'creating the exact dependency lock',
  'dependency-audit':      'auditing the locked dependency graph',
  'dependency-install':    'installing the locked dependencies',
  'native-materialization': 'materializing the verified worker-native executable',
  'staged-binary-check':   'checking the staged CLI executable',
  'worker-smoke':          'running the read-only worker smoke check',
  activation:              'activating the checked CLI release',
  timeout:                 'waiting for the worker update',
  unknown:                 'running the worker update',
};

export class ProviderCliUpdateError extends Error {
  constructor(readonly stage: ProviderCliUpdateStage, provider: string) {
    const name = provider === 'codex' ? 'Codex' : provider === 'claude-code' ? 'Claude Code' : 'provider';
    super(`${ name } CLI update stopped while ${ UPDATE_STAGE_LABELS[stage] }. The current selection was preserved. Check the worker image and try again.`);
    this.name = 'ProviderCliUpdateError';
  }
}

export function providerCliUpdateStageFromOutput(output: unknown): ProviderCliUpdateStage | undefined {
  if (typeof output !== 'string') return undefined;
  const matches = [...output.matchAll(/(?:^|\r?\n)SULLA_CLI_UPDATE_FAILURE:([a-z-]+)(?:\r?\n|$)/g)];
  const candidate = matches.at(-1)?.[1] as ProviderCliUpdateStage | undefined;
  return candidate && Object.prototype.hasOwnProperty.call(UPDATE_STAGE_LABELS, candidate) ? candidate : undefined;
}

export interface ProviderCliVersion {
  provider:        string;
  installed?:      string;
  installedVersion?: string;
  imageInstalled?: string;
  vmInstalled?:    string;
  latest?:         string;
  updateAvailable: boolean;
  updateSupported: boolean;
  error?:          string;
}

function supportedPackage(provider: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PACKAGES, provider)
    ? PACKAGES[provider as keyof typeof PACKAGES]
    : undefined;
}

function normalizedCliVersion(value: string | undefined): string | undefined {
  const match = value?.match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?/);
  return match && VERSION.test(match[0]) ? match[0] : undefined;
}

function parseVersion(value: string | undefined): { core: number[]; prerelease?: string } | undefined {
  const match = normalizedCliVersion(value)?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/);
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] } : undefined;
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] === b[index]) continue;
    const an = /^\d+$/.test(a[index]);
    const bn = /^\d+$/.test(b[index]);
    if (an && bn) return Number(a[index]) < Number(b[index]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function newerCliRelease(installed: string | undefined, latest: string): boolean {
  const current = parseVersion(installed);
  const next = parseVersion(latest);
  if (!next) return false;
  if (!current) return true;
  for (let index = 0; index < 3; index++) {
    if (current.core[index] !== next.core[index]) return current.core[index] < next.core[index];
  }
  return comparePrerelease(current.prerelease, next.prerelease) < 0;
}

async function workerImageRef(): Promise<string> {
  const [{ resolveSullaServiceImage }, { app }] = await Promise.all([import('./sullaServiceImages'), import('electron')]);
  return resolveSullaServiceImage('sulla-agent', process.cwd(), app.getVersion(), process.env.SULLA_AGENT_IMAGE).image;
}

function workerImageProvider(provider: string): provider is keyof typeof PACKAGES {
  return SAFE_IMAGE_COMMANDS.has(provider) && Boolean(CLI_PROVIDERS[provider]);
}

async function workerImageVersion(provider: string, prefix?: string): Promise<string | undefined> {
  if (!workerImageProvider(provider)) return undefined;
  const [image, identity] = await Promise.all([workerImageRef(), getGuestRuntimeIdentity()]);
  const args = ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--user', `${ identity.uid }:${ identity.gid }`, '--env', 'HOME=/tmp',
    '--label', 'com.sulla.workload=cli-version-check'];
  if (prefix) {
    const version = prefix.split('/').at(-1)!;
    const target = `/opt/sulla-provider-clis/${ provider }/${ version }`;
    const imagePath = '/mnt/data/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    args.push('--volume', `${ prefix }:${ target }:ro`, '--env', `PATH=${ target }/node_modules/.bin:${ imagePath }`);
  }
  args.push('--entrypoint', CLI_PROVIDERS[provider].command, image, '--version');
  const result = await runCommand('docker', args, { runInGuest: true, timeoutMs: 15_000, maxOutputChars: 4_000 });
  if (result.exitCode !== 0) return undefined;
  return (result.stdout || result.stderr).trim() || undefined;
}

/** Read a version from the actual worker image, never from the host VM helper. */
export async function getWorkerImageCliVersion(provider: string): Promise<string | undefined> {
  return normalizedCliVersion(await workerImageVersion(provider));
}

async function latestVersion(provider: string): Promise<string> {
  const packageName = supportedPackage(provider);
  if (!packageName) throw new Error('This CLI has no supported versioned package installer.');
  try {
    const response = await fetch(`https://registry.npmjs.org/${ encodeURIComponent(packageName) }/latest`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('unavailable');
    const body = await response.json() as { name?: string; version?: string };
    if (body.name !== packageName || !body.version || !VERSION.test(body.version)) throw new Error('invalid');
    return body.version;
  } catch (error) {
    if (error instanceof Error && (error.message === 'invalid')) throw new Error('The publisher returned an invalid CLI release.');
    throw new Error('The publisher version check is unavailable.');
  }
}

async function selectedCliVersion(provider: string, version: string): Promise<string | undefined> {
  const prefix = providerCliPrefix(provider, version);
  return workerImageVersion(provider, prefix);
}

export async function captureProviderCliSnapshot(): Promise<ProviderCliSnapshot> {
  const selected = await SullaSettingsModel.get(SETTING, {}) as Record<string, unknown>;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('Saved provider CLI selections are invalid; refusing an image-default fallback.');
  return providerCliSnapshotForSelection(selected);
}

export async function checkProviderCliVersions(providers: string[]): Promise<ProviderCliVersion[]> {
  const selected = await SullaSettingsModel.get(SETTING, {}) as Record<string, unknown>;
  const unique = [...new Set(providers)].filter(provider => CLI_PROVIDERS[provider]);
  return Promise.all(unique.map(async provider => {
    const errors: string[] = [];
    const packageName = supportedPackage(provider);
    const updateSupported = Boolean(packageName);
    let vmInstalled: string | undefined;
    let imageInstalled: string | undefined;
    let installed: string | undefined;
    let latest: string | undefined;
    const selectedVersion = selected?.[provider];
    try { vmInstalled = (await getCliStatus(provider)).version } catch { errors.push('VM CLI version is unavailable.') }
    if (workerImageProvider(provider)) {
      try { imageInstalled = await workerImageVersion(provider) } catch { errors.push('Worker image CLI version is unavailable.') }
      if (typeof selectedVersion === 'string' && VERSION.test(selectedVersion)) {
        try { installed = await selectedCliVersion(provider, selectedVersion) } catch { errors.push('Selected versioned CLI could not be checked in the worker image.') }
        if (!installed) errors.push('Selected versioned CLI is missing or failed its read-only version check.');
      } else {
        installed = imageInstalled;
      }
    }
    if (packageName) {
      try { latest = await latestVersion(provider) } catch (error) { errors.push(error instanceof Error ? error.message : 'Publisher version check failed.') }
    } else {
      errors.push('This provider is VM-managed and has no safe versioned worker package update path.');
    }
    return {
      provider,
      installed,
      installedVersion: normalizedCliVersion(installed),
      imageInstalled,
      vmInstalled,
      latest,
      updateSupported,
      updateAvailable: updateSupported && Boolean(latest) && newerCliRelease(installed, latest!),
      ...(errors.length ? { error: errors.join(' ') } : {}),
    };
  }));
}

function shellQuote(value: string): string { return `'${ value.replace(/'/g, `'"'"'`) }'` }

export function buildProviderCliInstallCommand(provider: keyof typeof PACKAGES, version: string, prefix: string, image: string, uid: number, gid: number): string {
  const packageName = PACKAGES[provider];
  const executable = CLI_PROVIDERS[provider].command;
  const audit = String.raw`const fs=require('node:fs');const p=process.argv[1],pkg=process.argv[2],v=process.argv[3],native=process.argv[4]||'';const l=JSON.parse(fs.readFileSync(p,'utf8'));const root=l.packages&&l.packages[''];const direct=l.packages&&l.packages['node_modules/'+pkg];if(!root||root.dependencies?.[pkg]!==v||!direct||direct.version!==v)process.exit(2);if(native&&(!direct.optionalDependencies||direct.optionalDependencies[native]!==v||!l.packages['node_modules/'+native]||l.packages['node_modules/'+native].version!==v))process.exit(5);for(const [loc,x] of Object.entries(l.packages||{})){const name=x.name||loc.split('node_modules/').at(-1);if(name==='axios'&&['1.14.1','0.30.4'].includes(x.version))process.exit(3);if(name==='plain-crypto-js'&&x.version==='4.2.1')process.exit(4)}`;
  const nativeMaterialization = String.raw`const fs=require('node:fs'),path=require('node:path');const [root,wrapperName,version,provider,cpu,libc]=process.argv.slice(1);const fail=message=>{throw new Error(message)};const contained=(base,relative)=>{const baseReal=fs.realpathSync(base);const candidate=path.resolve(baseReal,relative);if(candidate!==baseReal&&!candidate.startsWith(baseReal+path.sep))fail('path containment check failed');return candidate};const regular=(file,label)=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())fail(label+' is not a regular file');return stat};const wrapperDir=contained(root,path.join('node_modules',wrapperName));if(fs.lstatSync(wrapperDir).isSymbolicLink()||fs.realpathSync(wrapperDir)!==wrapperDir)fail('wrapper directory is not contained');const wrapperManifest=JSON.parse(fs.readFileSync(contained(wrapperDir,'package.json'),'utf8'));if(wrapperManifest.name!==wrapperName||wrapperManifest.version!==version)fail('wrapper package version mismatch');if(provider!=='claude-code'){console.log('No native materialization required for this CLI');process.exit(0)}if(!['x64','arm64'].includes(cpu)||!['glibc','musl'].includes(libc))fail('unsupported worker ABI');const suffix='linux-'+cpu+(libc==='musl'?'-musl':'');const nativeName=wrapperName+'-'+suffix;if(wrapperManifest.optionalDependencies?.[nativeName]!==version)fail('worker-native optional dependency is not declared at the exact wrapper version');const nativeDir=contained(root,path.join('node_modules',nativeName));if(fs.lstatSync(nativeDir).isSymbolicLink()||fs.realpathSync(nativeDir)!==nativeDir)fail('native package directory is not contained');const nativeManifest=JSON.parse(fs.readFileSync(contained(nativeDir,'package.json'),'utf8'));if(nativeManifest.name!==nativeName||nativeManifest.version!==version)fail('native package version mismatch');const source=contained(nativeDir,'claude');const destination=contained(wrapperDir,'bin/claude.exe');const sourceStat=regular(source,'native source');if((sourceStat.mode&0o111)===0)fail('native source is not executable');regular(destination,'wrapper destination');fs.copyFileSync(source,destination);fs.chmodSync(destination,0o755);const destinationStat=regular(destination,'materialized destination');if((destinationStat.mode&0o111)===0)fail('materialized destination is not executable');console.log('Verified native binary materialized for actual worker ABI');`;
  const workerAbiProbe = String.raw`set -eu; os=$(uname -s); machine=$(uname -m); case "$machine" in aarch64|arm64) cpu=arm64;; x86_64|amd64) cpu=x64;; *) exit 72;; esac; libc=$(node -e 'const report=typeof process.report?.getReport==="function"?process.report.getReport():null;if(!report?.header)process.exit(2);process.stdout.write(report.header.glibcVersionRuntime?"glibc":"musl")'); case "$libc" in glibc|musl) ;; *) exit 72;; esac; printf '%s %s %s\n' "$os" "$cpu" "$libc"`;
  const smoke = `set -eu; version=$(${ shellQuote(`/opt/sulla-cli-check/node_modules/.bin/${ executable }`) } --version 2>&1); printf '%s\\n' "$version" | grep -F -- ${ shellQuote(version) } >/dev/null; ${ shellQuote(`/opt/sulla-cli-check/node_modules/.bin/${ executable }`) } --help >/dev/null`;
  const workerAbi = `docker run --rm --pull=never --network=none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user ${ uid }:${ gid } --env HOME=/tmp --label com.sulla.workload=cli-update-check --entrypoint sh ${ shellQuote(image) } -c ${ shellQuote(workerAbiProbe) }`;
  const claudeAutoMemoryEnv = provider === 'claude-code' ? '--env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ' : '';
  const containerSmoke = (source: string) => `docker run --rm --pull=never --network=none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user ${ uid }:${ gid } --env HOME=/tmp --env CLAUDE_CONFIG_DIR=/tmp/.claude --env CODEX_HOME=/tmp/.codex ${ claudeAutoMemoryEnv }--env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --label com.sulla.workload=cli-update-check --volume "${ source }:/opt/sulla-cli-check:ro" --entrypoint sh ${ shellQuote(image) } -c ${ shellQuote(smoke) }`;
  return [
    'set -eu',
    'umask 022',
    // fd 3 keeps the original stderr for the static stage marker only; all
    // child stderr joins stdout so noisy output cannot push the marker past
    // the runner's head-only output cap.
    'exec 3>&2 2>&1',
    'phase=prepare',
    'emit_failure() { if [ "$1" -ne 0 ]; then /bin/busybox printf \'SULLA_CLI_UPDATE_FAILURE:%s\\n\' "$phase" >&3; fi; }',
    'trap \'status=$?; emit_failure "$status"; exit "$status"\' EXIT',
    `parent=${ shellQuote(prefix.slice(0, prefix.lastIndexOf('/'))) }`,
    `prefix=${ shellQuote(prefix) }`,
    '/bin/busybox mkdir -p "$parent"',
    'if [ -e "$prefix" ]; then',
    '  phase=existing-lock-audit',
    `  node -e ${ shellQuote(audit) } "$prefix/package-lock.json" ${ shellQuote(packageName) } ${ shellQuote(version) }`,
    '  phase=existing-binary-check',
    `  test -x "$prefix/node_modules/.bin/${ executable }"`,
    '  phase=worker-smoke',
    `  ${ containerSmoke('$prefix') }`,
    'else',
    '  stage=$(/bin/busybox mktemp -d "$parent/.install-XXXXXX")',
    '  trap \'status=$?; /bin/busybox rm -rf "$stage"; emit_failure "$status"; exit "$status"\' EXIT',
    '  phase=worker-abi',
    `  worker_abi=$(${ workerAbi })`,
    '  set -- $worker_abi',
    '  [ "$#" -eq 3 ]',
    '  worker_os="$1"; worker_cpu="$2"; worker_libc="$3"',
    '  [ "$worker_os" = Linux ]',
    '  case "$worker_cpu:$worker_libc" in x64:glibc|x64:musl|arm64:glibc|arm64:musl) ;; *) exit 72 ;; esac',
    `  cli_provider=${ shellQuote(provider) }`,
    '  native_package=""',
    `  if [ "$cli_provider" = claude-code ]; then native_package=${ shellQuote(packageName) }-linux-"$worker_cpu"; if [ "$worker_libc" = musl ]; then native_package="$native_package-musl"; fi; fi`,
    '  phase=dependency-lock',
    `  npm install --prefix "$stage" --package-lock-only --ignore-scripts --save-exact --no-fund --no-audit --registry=https://registry.npmjs.org ${ shellQuote(`${ packageName }@${ version }`) }`,
    '  phase=dependency-audit',
    `  node -e ${ shellQuote(audit) } "$stage/package-lock.json" ${ shellQuote(packageName) } ${ shellQuote(version) } "$native_package"`,
    '  phase=dependency-install',
    '  npm ci --prefix "$stage" --ignore-scripts --engine-strict --libc="$worker_libc" --os=linux --cpu="$worker_cpu" --no-fund --no-audit --registry=https://registry.npmjs.org',
    '  phase=native-materialization',
    `  node -e ${ shellQuote(nativeMaterialization) } "$stage" ${ shellQuote(packageName) } ${ shellQuote(version) } "$cli_provider" "$worker_cpu" "$worker_libc"`,
    '  phase=staged-binary-check',
    `  test -x "$stage/node_modules/.bin/${ executable }"`,
    '  /bin/busybox chmod -R a+rX,go-w "$stage"',
    '  phase=worker-smoke',
    `  ${ containerSmoke('$stage') }`,
    '  phase=activation',
    '  /bin/busybox mv "$stage" "$prefix"',
    '  trap - EXIT',
    'fi',
  ].join('\n');
}

/** Install one checked release only after the main-process owner confirmed its exact version. */
export async function installConfirmedProviderCli(provider: string, version: string): Promise<void> {
  const packageName = supportedPackage(provider);
  if (!packageName || !VERSION.test(version) || !CLI_PROVIDERS[provider]) throw new Error('Unsupported provider CLI update.');
  assertConfirmedCliUpdate();
  if (updateInFlight) throw new Error('Another provider CLI update is already running.');
  updateInFlight = true;
  const typedProvider = provider as keyof typeof PACKAGES;
  const prefix = providerCliPrefix(typedProvider, version);
  try {
    if (await latestVersion(provider) !== version) throw new Error('The available CLI release changed. Refresh and confirm the new version.');
    let image: string;
    let identity: { uid: number; gid: number };
    try {
      [image, identity] = await Promise.all([workerImageRef(), getGuestRuntimeIdentity()]);
    } catch {
      throw new ProviderCliUpdateError('prepare', typedProvider);
    }
    const command = buildProviderCliInstallCommand(typedProvider, version, prefix, image, identity.uid, identity.gid);
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(command, [], { runInGuest: true, timeoutMs: 240_000, maxOutputChars: 4_000 });
    } catch {
      throw new ProviderCliUpdateError('unknown', typedProvider);
    }
    if (result.exitCode !== 0) {
      // Only the script's dedicated marker channel (original stderr) names a stage;
      // child output is on stdout and can neither hide nor forge the marker.
      const stage = providerCliUpdateStageFromOutput(result.stderr) ?? (result.exitCode === -1 ? 'timeout' : 'unknown');
      throw new ProviderCliUpdateError(stage, typedProvider);
    }
    const saved = await SullaSettingsModel.get(SETTING, {}) as Record<string, string>;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved provider CLI selections are invalid; the installed release was preserved without changing the active selection.');
    try {
      await SullaSettingsModel.set(SETTING, { ...saved, [typedProvider]: version }, 'json');
    } catch {
      throw new ProviderCliUpdateError('activation', typedProvider);
    }
  } finally {
    updateInFlight = false;
  }
}

export { providerCliContainerSettings, providerCliPrefix, PROVIDER_CLI_IDS };
