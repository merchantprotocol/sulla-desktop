#!/usr/bin/env node
'use strict';

// Sulla Desktop one-command launcher: `npx sulla-desktop`.
//
// Downloads the latest Sulla Desktop release from GitHub, verifies its
// sha256 digest, installs it where the current user can write without sudo,
// and launches it. If Sulla is already installed it just launches it, and a
// running copy is never replaced or killed.
//
// Zero dependencies. Node >= 18 (built-in fetch). Mirrors the asset logic in
// the repo's install.sh.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const REPO = 'merchantprotocol/sulla-desktop';
const APP_NAME = 'Sulla Desktop';
const PKG = require('./package.json');
const CMD = PKG.name; // `sulla-desktop` today; `sulla` if we get that name.
const SERVER_COMMAND = 'server';

// ─── Output ─────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${ code }m${ s }\x1b[0m` : s);
const log = (s = '') => console.log(`${ paint('36', '◆') } ${ s }`);
const ok = s => console.log(`${ paint('32', '✔') } ${ s }`);
const warn = s => console.log(`${ paint('33', '!') } ${ s }`);
const bold = s => paint('1', s);
const dim = s => paint('2', s);

class UserError extends Error {}

// ─── Args ───────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { update: false, launch: true, version: null, dryRun: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--update' || a === '-u') {
      opts.update = true;
    } else if (a === '--no-launch') {
      opts.launch = false;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--version' || a === '-v') {
      const next = argv[i + 1];

      if (!next || next.startsWith('-')) {
        throw new UserError('--version needs a release tag, for example: --version v1.6.1');
      }
      opts.version = next;
      i++;
    } else if (a.startsWith('--version=')) {
      opts.version = a.slice('--version='.length);
    } else {
      throw new UserError(`Unknown option: ${ a }\nRun "npx ${ CMD } --help" to see the options.`);
    }
  }
  if (opts.version && !opts.version.startsWith('v')) {
    opts.version = `v${ opts.version }`;
  }

  return opts;
}

function printHelp() {
  console.log(`${ bold(`npx ${ CMD }`) } — download and launch ${ APP_NAME }

Usage:
  npx ${ CMD }                   Install (first run) or open ${ APP_NAME }
  npx ${ CMD } server            Install Sulla Server on Linux
  npx ${ CMD } --update          Update to the latest release, then open it
  npx ${ CMD } --version v1.6.1  Install a specific release
  npx ${ CMD } --no-launch       Install or update without opening the app
  npx ${ CMD } --dry-run         Show what would be downloaded and where; change nothing
  npx ${ CMD } --help            Show this help

Where it installs (no sudo needed):
  macOS    ~/Applications/${ APP_NAME }.app (or /Applications if it already lives there)
  Linux    ~/.local/share/sulla-desktop, command at ~/.local/bin/sulla-desktop
  Windows  %LOCALAPPDATA%\\Programs\\${ APP_NAME }

A running ${ APP_NAME } is never replaced or closed. Quit it first to update.
Downloads come from github.com/${ REPO }/releases and are checked against
the sha256 digest GitHub publishes for each file.`);
}

// ─── Platform ───────────────────────────────────────────────

function run(cmd, args) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8' });

  return { status: r.error ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function hasCmd(cmd) {
  const probe = process.platform === 'win32' ? run('where', [cmd]) : run('sh', ['-c', `command -v ${ cmd }`]);

  return probe.status === 0;
}

function detectPlatform() {
  const p = process.platform;

  if (p === 'darwin') {
    // An x64 Node under Rosetta still reports x64; ask the kernel instead.
    const arm = run('sysctl', ['-n', 'hw.optional.arm64']).stdout === '1';

    return { os: 'mac', arch: arm || process.arch === 'arm64' ? 'arm64' : 'x64' };
  }
  if (p === 'linux') {
    return { os: 'linux', arch: process.arch };
  }
  if (p === 'win32') {
    return { os: 'win', arch: process.arch };
  }
  throw new UserError(`${ APP_NAME } doesn't have a build for ${ p } yet. Supported: macOS, Linux, Windows.`);
}

function pickAsset(release, plat) {
  const zips = release.assets.filter(a => /\.zip$/i.test(a.name));
  let asset;

  if (plat.os === 'mac') {
    const armRe = /(arm64|aarch64)/i;
    const macZips = zips.filter(a => /mac/i.test(a.name));

    asset = plat.arch === 'arm64'
      ? macZips.find(a => armRe.test(a.name))
      : macZips.find(a => /(x64|x86_64)/i.test(a.name)) || macZips.find(a => !armRe.test(a.name));
  } else if (plat.os === 'linux') {
    if (plat.arch !== 'x64') {
      throw new UserError(`There's no Linux ${ plat.arch } build yet — only x64. See https://github.com/${ REPO }/releases`);
    }
    asset = zips.find(a => /linux/i.test(a.name));
  } else {
    asset = zips.find(a => /win/i.test(a.name));
  }
  if (!asset) {
    throw new UserError(`Release ${ release.tag_name } has no download for ${ plat.os } ${ plat.arch }.`);
  }

  return asset;
}

// ─── Install locations ──────────────────────────────────────

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);

    return true;
  } catch {
    return false;
  }
}

function layout(plat) {
  const home = os.homedir();

  if (plat.os === 'mac') {
    const system = path.join('/Applications', `${ APP_NAME }.app`);
    const user = path.join(home, 'Applications', `${ APP_NAME }.app`);
    const existing = [system, user].find(p => fs.existsSync(p)) || null;

    return { existing, target: existing || user, exe: app => path.join(app, 'Contents', 'MacOS', APP_NAME) };
  }
  if (plat.os === 'linux') {
    const dir = path.join(home, '.local', 'share', 'sulla-desktop');

    return {
      existing: fs.existsSync(path.join(dir, 'sulla-desktop')) ? dir : null,
      target:   dir,
      exe:      d => path.join(d, 'sulla-desktop'),
    };
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dir = path.join(local, 'Programs', APP_NAME);

  return {
    existing: fs.existsSync(path.join(dir, `${ APP_NAME }.exe`)) ? dir : null,
    target:   dir,
    exe:      d => path.join(d, `${ APP_NAME }.exe`),
  };
}

const MARKER = '.sulla-npx-version';

function installedVersion(plat, dir) {
  if (plat.os === 'mac') {
    const plist = path.join(dir, 'Contents', 'Info.plist');

    try {
      const xml = fs.readFileSync(plist, 'utf8');
      const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);

      if (m) {
        return m[1].trim();
      }
    } catch { /* binary plist or unreadable — try plutil */ }
    const r = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);

    return r.status === 0 && r.stdout ? r.stdout : null;
  }
  try {
    return fs.readFileSync(path.join(dir, MARKER), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function isRunning(plat, lay) {
  if (plat.os === 'mac') {
    return run('pgrep', ['-f', `${ APP_NAME }.app/Contents/MacOS/${ APP_NAME }`]).status === 0;
  }
  if (plat.os === 'linux') {
    return run('pgrep', ['-f', lay.exe(lay.target)]).status === 0;
  }
  const r = run('tasklist', ['/FI', `IMAGENAME eq ${ APP_NAME }.exe`, '/NH']);

  return r.status === 0 && r.stdout.toLowerCase().includes(`${ APP_NAME }.exe`.toLowerCase());
}

// ─── GitHub ─────────────────────────────────────────────────

async function getRelease(tag) {
  const url = tag
    ? `https://api.github.com/repos/${ REPO }/releases/tags/${ encodeURIComponent(tag) }`
    : `https://api.github.com/repos/${ REPO }/releases/latest`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `${ CMD }-npx/${ PKG.version }` };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${ process.env.GITHUB_TOKEN }`;
  }
  const res = await fetch(url, { headers });

  if (res.status === 404) {
    throw new UserError(tag ? `Release ${ tag } not found.` : 'No published release found.');
  }
  if (res.status === 403 || res.status === 429) {
    throw new UserError('GitHub rate-limited this request. Wait a few minutes, or set GITHUB_TOKEN and try again.');
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${ res.status } for ${ url }`);
  }

  return res.json();
}

const cleanVersion = v => String(v || '').replace(/^v/i, '').trim();

function compareVersions(a, b) {
  const pa = cleanVersion(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = cleanVersion(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);

    if (d) {
      return d > 0 ? 1 : -1;
    }
  }

  return 0;
}

// ─── Download ───────────────────────────────────────────────

function fmtBytes(n) {
  return n >= 1e9 ? `${ (n / 1e9).toFixed(2) } GB` : `${ (n / 1e6).toFixed(0) } MB`;
}

async function download(asset, dest) {
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': `${ CMD }-npx/${ PKG.version }` } });

  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${ res.status }`);
  }
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  const tty = process.stdout.isTTY;
  const started = Date.now();
  let done = 0;
  let lastDraw = 0;
  let lastPct = -1;

  const draw = (final) => {
    const now = Date.now();
    const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;

    if (tty) {
      if (!final && now - lastDraw < 100) {
        return;
      }
      lastDraw = now;
      const width = 30;
      const filled = Math.round((pct / 100) * width);
      const secs = Math.max(0.001, (now - started) / 1000);
      const rate = `${ fmtBytes(done / secs) }/s`;

      process.stdout.write(`\r  [${ '█'.repeat(filled) }${ '░'.repeat(width - filled) }] ${ String(pct).padStart(3) }%  ${ fmtBytes(done) } / ${ fmtBytes(total) }  ${ dim(rate) }   `);
      if (final) {
        process.stdout.write('\n');
      }
    } else if (pct >= lastPct + 10 || final) {
      lastPct = pct;
      console.log(`  ${ pct }%  ${ fmtBytes(done) } / ${ fmtBytes(total) }`);
    }
  };

  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(res.body);

    body.on('data', (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      draw(false);
    });
    body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    body.pipe(out);
  });
  draw(true);

  return hash.digest('hex');
}

// ─── Extract ────────────────────────────────────────────────

function extractZip(plat, zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const attempts = [];

  if (plat.os === 'mac') {
    attempts.push(['ditto', ['-xk', zip, dest]]);
  } else if (plat.os === 'linux') {
    attempts.push(['unzip', ['-q', zip, '-d', dest]], ['bsdtar', ['-xf', zip, '-C', dest]]);
  } else {
    // tar.exe (bsdtar) ships with Windows 10 1803+ and reads zips quickly.
    attempts.push(
      ['tar', ['-xf', zip, '-C', dest]],
      ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ zip.replace(/'/g, "''") }' -DestinationPath '${ dest.replace(/'/g, "''") }' -Force`]],
    );
  }
  for (const [cmd, args] of attempts) {
    if (!hasCmd(cmd)) {
      continue;
    }
    const r = run(cmd, args);

    if (r.status === 0) {
      return;
    }
    throw new Error(`${ cmd } failed to extract the download: ${ r.stderr || `exit ${ r.status }` }`);
  }
  if (plat.os === 'linux' && hasCmd('python3')) {
    const r = run('python3', ['-I', '-m', 'zipfile', '-e', zip, dest]);

    if (r.status === 0) {
      return;
    }
  }
  throw new UserError(plat.os === 'linux'
    ? 'Need "unzip" to extract Sulla Desktop. Install it (e.g. sudo apt install unzip) and run this again.'
    : 'Could not find a tool to extract the download.');
}

// Electron-builder zips put the payload either at the root or one folder down.
function findPayload(plat, root) {
  const isPayload = (dir) => {
    if (plat.os === 'mac') {
      return path.basename(dir).endsWith('.app');
    }

    return fs.existsSync(path.join(dir, plat.os === 'linux' ? 'sulla-desktop' : `${ APP_NAME }.exe`));
  };

  if (plat.os !== 'mac' && isPayload(root)) {
    return root;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);

    if (entry.isDirectory() && isPayload(child)) {
      return child;
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
      const child = path.join(root, entry.name, sub.name);

      if (sub.isDirectory() && isPayload(child)) {
        return child;
      }
    }
  }
  throw new Error('The download did not contain the Sulla Desktop app.');
}

function rmrf(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Swap the new build into place; roll back to the old one if the swap fails.
function swapInto(payload, target) {
  const backup = `${ target }.old-${ process.pid }`;
  const hadOld = fs.existsSync(target);

  if (hadOld) {
    fs.renameSync(target, backup);
  }
  try {
    try {
      fs.renameSync(payload, target);
    } catch (err) {
      if (err.code !== 'EXDEV') {
        throw err;
      }
      fs.cpSync(payload, target, { recursive: true, verbatimSymlinks: true });
    }
  } catch (err) {
    rmrf(target);
    if (hadOld) {
      fs.renameSync(backup, target);
    }
    throw err;
  }
  rmrf(backup);
}

// First PNG whose name looks like an app icon, a few folders deep.
function findIcon(dir, depth) {
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(e => e.isFile() && /(icon|logo).*\.png$/i.test(e.name));

  if (hit) {
    return path.join(dir, hit.name);
  }
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') {
        const found = findIcon(path.join(dir, e.name), depth - 1);

        if (found) {
          return found;
        }
      }
    }
  }

  return null;
}

function linuxIntegrate(dir, version) {
  const exe = path.join(dir, 'sulla-desktop');
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const link = path.join(binDir, 'sulla-desktop');
  const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');

  for (const f of [exe, path.join(dir, 'chrome_crashpad_handler')]) {
    if (fs.existsSync(f)) {
      fs.chmodSync(f, 0o755);
    }
  }
  fs.mkdirSync(binDir, { recursive: true });
  try {
    fs.unlinkSync(link);
  } catch { /* not there yet */ }
  fs.symlinkSync(exe, link);

  const iconPath = findIcon(path.join(dir, 'resources'), 3);
  const icon = iconPath ? `Icon=${ iconPath }\n` : '';

  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(path.join(appsDir, 'sulla-desktop.desktop'), `[Desktop Entry]
Name=${ APP_NAME }
Comment=Sulla Desktop ${ version }
Exec="${ exe }" %U
${ icon }Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=${ APP_NAME }
`);

  const onPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);

  return { link, onPath };
}

async function install(plat, lay, release, asset) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-desktop-'));
  // Extract next to the target so the final move is a same-disk rename.
  const parent = path.dirname(lay.target);
  let staging = null;

  const cleanup = () => {
    rmrf(tmp);
    rmrf(staging);
  };
  const onSignal = () => {
    cleanup();
    console.log('\nCancelled. Nothing was changed.');
    process.exit(130);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    fs.mkdirSync(parent, { recursive: true });
    if (!writable(parent)) {
      throw new UserError(`Can't write to ${ parent }. Move ${ APP_NAME } somewhere you own, or fix that folder's permissions, then run this again.`);
    }
    staging = fs.mkdtempSync(path.join(parent, '.sulla-desktop-staging-'));

    const zip = path.join(tmp, asset.name);

    log(`Downloading ${ bold(asset.name) } (${ fmtBytes(asset.size) })`);
    const actual = await download(asset, zip);
    const expected = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();

    if (!expected) {
      throw new UserError(`GitHub didn't publish a checksum for ${ asset.name }, so it can't be verified. Not installing it.`);
    }
    if (actual !== expected) {
      throw new UserError(`Checksum mismatch for ${ asset.name } — the download is corrupt or was tampered with. Nothing was installed.\n  expected ${ expected }\n  got      ${ actual }`);
    }
    ok('Checksum verified (sha256)');

    log('Unpacking…');
    extractZip(plat, zip, staging);
    rmrf(tmp);
    const payload = findPayload(plat, staging);

    if (plat.os !== 'mac') {
      fs.writeFileSync(path.join(payload, MARKER), cleanVersion(release.tag_name));
    }
    swapInto(payload, lay.target);
    rmrf(staging);
    staging = null;
    ok(`Installed ${ APP_NAME } ${ cleanVersion(release.tag_name) } → ${ lay.target }`);

    if (plat.os === 'linux') {
      const { link, onPath } = linuxIntegrate(lay.target, cleanVersion(release.tag_name));

      ok(`Added the "sulla-desktop" command (${ link }) and an app-menu entry`);
      if (!onPath) {
        warn(`${ path.dirname(link) } isn't on your PATH. Add it to run "sulla-desktop" directly.`);
      }
    }
  } finally {
    cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

// ─── Launch ─────────────────────────────────────────────────

function launch(plat, lay) {
  const target = lay.existing || lay.target;

  if (plat.os === 'mac') {
    // `open` launches the app, or brings a running one to the front.
    const r = run('open', [target]);

    if (r.status !== 0) {
      throw new Error(`Couldn't open ${ target }: ${ r.stderr }`);
    }

    return;
  }
  // Sulla holds a single-instance lock, so a second launch just focuses the
  // window that's already open.
  const child = childProcess.spawn(lay.exe(target), [], { detached: true, stdio: 'ignore', windowsHide: false });

  child.on('error', err => warn(`Couldn't start ${ APP_NAME }: ${ err.message }`));
  child.unref();
}

// ─── Main ───────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === SERVER_COMMAND) {
    const { runServer } = require('./server');

    runServer(argv.slice(1), `npx ${ CMD }`);

    return;
  }

  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();

    return;
  }

  console.log(`\n${ bold(APP_NAME) } ${ dim(`· npx ${ CMD }`) }\n`);
  const plat = detectPlatform();
  const lay = layout(plat);
  const current = lay.existing ? installedVersion(plat, lay.existing) : null;
  const running = lay.existing ? isRunning(plat, lay) : false;

  if (lay.existing) {
    log(`Found ${ APP_NAME }${ current ? ` ${ current }` : '' } at ${ lay.existing }${ running ? ' (running)' : '' }`);
  }

  let release;

  try {
    log(opts.version ? `Looking up release ${ opts.version }…` : 'Checking for the latest release…');
    release = await getRelease(opts.version);
  } catch (err) {
    if (lay.existing && !opts.dryRun && !opts.update && !opts.version) {
      warn(`Couldn't check for updates (${ err.message }). Opening the copy you have.`);
      if (opts.launch) {
        launch(plat, lay);
      }

      return;
    }
    throw err;
  }
  const target = cleanVersion(release.tag_name);
  const asset = pickAsset(release, plat);

  let upToDate = false;

  if (lay.existing) {
    if (opts.version) {
      upToDate = current !== null && compareVersions(current, target) === 0;
    } else if (current) {
      upToDate = compareVersions(current, target) >= 0;
    } else {
      // Version unknown (installed some other way): only replace on --update.
      upToDate = !opts.update;
    }
  }

  if (opts.dryRun) {
    log(`Platform:  ${ plat.os } ${ plat.arch }`);
    log(`Release:   ${ release.tag_name }`);
    log(`Asset:     ${ asset.name } (${ fmtBytes(asset.size) })`);
    log(`Checksum:  ${ asset.digest || 'none published' }`);
    log(`Install:   ${ lay.target }`);
    const action = upToDate
      ? 'open the installed copy'
      : running
        ? 'nothing — Sulla is running, quit it first to update'
        : lay.existing ? 'replace the installed copy' : 'install';

    log(`Would:     ${ action }${ opts.launch && !upToDate && !running ? ', then open it' : '' }`);
    ok('Dry run — nothing was downloaded or changed.');

    return;
  }

  if (upToDate) {
    if (opts.launch) {
      ok(running ? `${ APP_NAME } is up to date and already running — bringing it to the front.` : `${ APP_NAME } is up to date. Opening it…`);
      launch(plat, lay);
    } else {
      ok(`${ APP_NAME }${ current ? ` ${ current }` : '' } is already installed and up to date.`);
    }

    return;
  }

  if (running) {
    if (opts.launch) {
      launch(plat, lay);
    }
    warn(`Update available: ${ current || 'installed' } → ${ target }.`);
    console.log(`  ${ APP_NAME } is running, so I left it alone. Quit Sulla, then run:\n\n    ${ bold(`npx ${ CMD } --update`) }\n`);

    return;
  }

  if (lay.existing) {
    log(`Updating ${ current || 'installed copy' } → ${ target }`);
  } else {
    log(`Installing ${ APP_NAME } ${ target } for ${ plat.os === 'mac' ? 'macOS' : plat.os === 'linux' ? 'Linux' : 'Windows' } (${ plat.arch })`);
  }
  await install(plat, lay, release, asset);

  if (opts.launch) {
    log(`Opening ${ APP_NAME }…`);
    launch(plat, { ...lay, existing: lay.target });
    ok(`Done. Next time, just run ${ bold(`npx ${ CMD }`) } — it opens the app and checks for updates.`);
  } else {
    ok('Done.');
  }
}

main().catch((err) => {
  const { ServerUserError } = require('./server');

  if (err instanceof UserError || err instanceof ServerUserError) {
    console.error(`\n${ paint('31', '✖') } ${ err.message }`);
  } else {
    console.error(`\n${ paint('31', '✖') } Something went wrong: ${ err && err.stack ? err.stack : err }`);
    console.error(`  Report it at https://github.com/${ REPO }/issues`);
  }
  process.exit(1);
});
