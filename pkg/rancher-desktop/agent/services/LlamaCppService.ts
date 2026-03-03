import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync, spawn } from 'child_process';

const LOG_PREFIX = '[LlamaCppService]';

/** GitHub API endpoint for latest llama.cpp release */
const GITHUB_API_LATEST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

/**
 * Resolves the project root directory.
 * In development: process.cwd() (the sulla-desktop repo root).
 * In production (packaged): the directory containing the .app / .exe.
 */
function getProjectRoot(): string {
    try {
        const { app } = require('electron');
        if (app?.isPackaged) {
            // Packaged app: place llm/ next to the app bundle
            return path.dirname(app.getAppPath());
        }
    } catch {
        // Not in Electron context
    }
    return process.cwd();
}

/** Top-level llm directory inside the project */
function getLlmRoot(): string {
    return path.join(getProjectRoot(), 'llm');
}

/** llama-cpp binary directory */
function getLlamaCppDir(): string {
    return path.join(getLlmRoot(), 'llama-cpp');
}

/** Models directory */
function getModelsDir(): string {
    return path.join(getLlmRoot(), 'models');
}

/** Training directory (future use) */
function getTrainingDir(): string {
    return path.join(getLlmRoot(), 'training');
}

/** Version file that records which build tag is installed */
function getVersionFile(): string {
    return path.join(getLlamaCppDir(), '.version');
}

/**
 * Determine the correct GitHub release asset name for this platform + arch.
 */
function getAssetPattern(tag: string): { name: string; ext: 'tar.gz' | 'zip' } | null {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'darwin') {
        const suffix = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
        return { name: `llama-${tag}-bin-${suffix}.tar.gz`, ext: 'tar.gz' };
    }

    if (platform === 'linux') {
        // Default to CPU Ubuntu x64 build
        return { name: `llama-${tag}-bin-ubuntu-x64.tar.gz`, ext: 'tar.gz' };
    }

    if (platform === 'win32') {
        const suffix = arch === 'arm64' ? 'win-cpu-arm64' : 'win-cpu-x64';
        return { name: `llama-${tag}-bin-${suffix}.zip`, ext: 'zip' };
    }

    return null;
}

/**
 * Simple HTTPS GET that follows redirects and returns a Buffer.
 */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const makeRequest = (requestUrl: string, remainingRedirects: number) => {
            if (remainingRedirects <= 0) {
                return reject(new Error('Too many redirects'));
            }

            const mod = requestUrl.startsWith('https') ? https : http;
            const req = mod.get(requestUrl, { headers }, (res) => {
                // Follow redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return makeRequest(res.headers.location, remainingRedirects - 1);
                }
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('error', reject);
        };
        makeRequest(url, 10);
    });
}

/**
 * Fetch the latest release tag from GitHub.
 */
async function fetchLatestTag(): Promise<string> {
    const data = await httpGet(GITHUB_API_LATEST, {
        'User-Agent': 'sulla-desktop',
        Accept:       'application/vnd.github.v3+json',
    });
    const release = JSON.parse(data.toString('utf-8'));
    return release.tag_name;
}

/**
 * Download a release asset and extract it into the llama-cpp directory.
 */
async function downloadAndExtract(tag: string): Promise<void> {
    const asset = getAssetPattern(tag);
    if (!asset) {
        throw new Error(`${LOG_PREFIX} Unsupported platform: ${os.platform()} ${os.arch()}`);
    }

    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset.name}`;
    console.log(`${LOG_PREFIX} Downloading ${url} ...`);

    const buf = await httpGet(url, { 'User-Agent': 'sulla-desktop' });
    console.log(`${LOG_PREFIX} Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

    const llamaCppDir = getLlamaCppDir();

    // Write archive to temp file
    const tmpFile = path.join(os.tmpdir(), asset.name);
    fs.writeFileSync(tmpFile, buf);

    try {
        if (asset.ext === 'tar.gz') {
            // Extract tar.gz — works on macOS and Linux
            execSync(`tar -xzf "${tmpFile}" -C "${llamaCppDir}"`, { stdio: 'pipe' });
        } else {
            // Extract zip — Windows
            if (os.platform() === 'win32') {
                execSync(`powershell -Command "Expand-Archive -Force -Path '${tmpFile}' -DestinationPath '${llamaCppDir}'"`, { stdio: 'pipe' });
            } else {
                execSync(`unzip -o "${tmpFile}" -d "${llamaCppDir}"`, { stdio: 'pipe' });
            }
        }
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    // On Unix, ensure binaries are executable
    if (os.platform() !== 'win32') {
        const binDir = path.join(llamaCppDir, 'build', 'bin');
        if (fs.existsSync(binDir)) {
            execSync(`chmod +x "${binDir}"/*`, { stdio: 'pipe' });
        }
        // Some releases put binaries at the root of the archive
        for (const name of ['llama-server', 'llama-cli', 'llama-quantize']) {
            const p = path.join(llamaCppDir, name);
            if (fs.existsSync(p)) {
                fs.chmodSync(p, 0o755);
            }
        }
    }

    // Write version file
    fs.writeFileSync(getVersionFile(), tag, 'utf-8');
    console.log(`${LOG_PREFIX} Installed llama.cpp ${tag}`);
}

/**
 * Find the llama-server binary inside the extracted directory tree.
 */
function findBinary(name: string): string | null {
    const llamaCppDir = getLlamaCppDir();
    const exeName = os.platform() === 'win32' ? `${name}.exe` : name;

    // Check common locations
    const candidates = [
        path.join(llamaCppDir, exeName),
        path.join(llamaCppDir, 'build', 'bin', exeName),
        path.join(llamaCppDir, 'bin', exeName),
    ];

    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c;
        }
    }

    // Recursive search (one level deep in subdirs)
    try {
        const entries = fs.readdirSync(llamaCppDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const nested = path.join(llamaCppDir, entry.name, exeName);
                if (fs.existsSync(nested)) {
                    return nested;
                }
                // One more level
                const binNested = path.join(llamaCppDir, entry.name, 'bin', exeName);
                if (fs.existsSync(binNested)) {
                    return binNested;
                }
            }
        }
    } catch { /* ignore */ }

    return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _instance: LlamaCppService | null = null;

export function getLlamaCppService(): LlamaCppService {
    if (!_instance) {
        _instance = new LlamaCppService();
    }
    return _instance;
}

export class LlamaCppService {
    private _ready = false;
    private _installedTag: string | null = null;

    /** Paths exposed for other services */
    get llmRoot(): string { return getLlmRoot(); }
    get llamaCppDir(): string { return getLlamaCppDir(); }
    get modelsDir(): string { return getModelsDir(); }
    get trainingDir(): string { return getTrainingDir(); }

    get installedTag(): string | null { return this._installedTag; }
    get isReady(): boolean { return this._ready; }

    /**
     * Resolve the absolute path to a llama.cpp binary (e.g. 'llama-server').
     * Returns null if not installed.
     */
    getBinaryPath(name: string): string | null {
        return findBinary(name);
    }

    /**
     * Ensure llama.cpp is installed. Downloads if missing.
     * Safe to call on every startup — no-ops if already present and up to date.
     */
    async ensure(): Promise<void> {
        console.log(`${LOG_PREFIX} Ensuring llama.cpp is installed...`);

        // Create directory structure
        for (const dir of [getLlmRoot(), getLlamaCppDir(), getModelsDir(), getTrainingDir()]) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Check if already installed
        const versionFile = getVersionFile();
        let currentTag: string | null = null;
        if (fs.existsSync(versionFile)) {
            currentTag = fs.readFileSync(versionFile, 'utf-8').trim();
        }

        // Verify the binary actually exists (guards against partial installs)
        const serverBin = findBinary('llama-server');
        if (currentTag && serverBin) {
            console.log(`${LOG_PREFIX} llama.cpp ${currentTag} already installed at ${serverBin}`);
            this._installedTag = currentTag;
            this._ready = true;
            return;
        }

        // Download latest release
        try {
            console.log(`${LOG_PREFIX} Fetching latest release tag from GitHub...`);
            const latestTag = await fetchLatestTag();
            console.log(`${LOG_PREFIX} Latest release: ${latestTag}`);

            await downloadAndExtract(latestTag);

            const bin = findBinary('llama-server');
            if (!bin) {
                console.error(`${LOG_PREFIX} Download succeeded but llama-server binary not found in extracted files`);
                this._ready = false;
                return;
            }

            console.log(`${LOG_PREFIX} llama-server binary located at ${bin}`);
            this._installedTag = latestTag;
            this._ready = true;
        } catch (err) {
            console.error(`${LOG_PREFIX} Failed to install llama.cpp:`, err);
            this._ready = false;
        }
    }

    /**
     * Update to the latest release. Forces re-download even if already installed.
     */
    async update(): Promise<void> {
        console.log(`${LOG_PREFIX} Checking for updates...`);

        const latestTag = await fetchLatestTag();
        if (latestTag === this._installedTag) {
            console.log(`${LOG_PREFIX} Already at latest version ${latestTag}`);
            return;
        }

        console.log(`${LOG_PREFIX} Updating from ${this._installedTag ?? 'none'} to ${latestTag}`);
        await downloadAndExtract(latestTag);
        this._installedTag = latestTag;
        this._ready = !!findBinary('llama-server');
    }
}
