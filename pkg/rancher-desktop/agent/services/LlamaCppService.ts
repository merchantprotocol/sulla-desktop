import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync, spawn, ChildProcess } from 'child_process';

const LOG_PREFIX = '[LlamaCppService]';

/** Port llama-server listens on (same as old Ollama port) */
const LLAMA_SERVER_PORT = 30114;

/** GitHub API endpoint for latest llama.cpp release */
const GITHUB_API_LATEST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

/**
 * Registry of GGUF models available for download.
 * Keys match the model names used in FirstRunResources.vue.
 * Each entry has the direct HuggingFace download URL and filename.
 */
export interface GGUFModelEntry {
    displayName: string;
    filename: string;
    url: string;
    size: string;
    minMemoryGB: number;
    minCPUs: number;
    description: string;
}

export const GGUF_MODELS: Record<string, GGUFModelEntry> = {
    'qwen3.5-9b': {
        displayName: 'Qwen3.5 9B',
        filename: 'Qwen3.5-9B-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
        size: '5.6GB',
        minMemoryGB: 8,
        minCPUs: 4,
        description: "Qwen3.5 9B — latest generation, strong reasoning default",
    },
    'qwen3.5-0.8b': {
        displayName: 'Qwen3.5 0.8B',
        filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
        size: '600MB',
        minMemoryGB: 1,
        minCPUs: 1,
        description: "Qwen3.5 0.8B — fast and lightweight",
    },
    'qwen2-1.5b': {
        displayName: 'Qwen2 1.5B',
        filename: 'qwen2-1_5b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2-1.5B-Instruct-GGUF/resolve/main/qwen2-1_5b-instruct-q4_k_m.gguf',
        size: '1.0GB',
        minMemoryGB: 2,
        minCPUs: 2,
        description: "Alibaba's Qwen2 model, efficient for basic tasks",
    },
    'phi3-mini': {
        displayName: 'Phi-3 Mini',
        filename: 'Phi-3-mini-4k-instruct-q4.gguf',
        url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
        size: '2.2GB',
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Microsoft's efficient 3.8B model, great reasoning capabilities",
    },
    'gemma-2b': {
        displayName: 'Gemma 2B',
        filename: 'gemma-2b-it-Q4_K_M.gguf',
        url: 'https://huggingface.co/google/gemma-2b-it-GGUF/resolve/main/gemma-2b-it-Q4_K_M.gguf',
        size: '1.7GB',
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Google's lightweight model, good general performance",
    },
    'llama3.2-1b': {
        displayName: 'Llama 3.2 1B',
        filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        size: '1.3GB',
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Meta's smallest Llama 3.2, efficient and capable",
    },
    'llama3.2-3b': {
        displayName: 'Llama 3.2 3B',
        filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        size: '2.0GB',
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Meta's compact Llama 3.2, balanced performance",
    },
    'mistral-7b': {
        displayName: 'Mistral 7B',
        filename: 'mistral-7b-instruct-v0.3.Q4_K_M.gguf',
        url: 'https://huggingface.co/MistralAI/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/mistral-7b-instruct-v0.3.Q4_K_M.gguf',
        size: '4.1GB',
        minMemoryGB: 5,
        minCPUs: 2,
        description: 'Excellent 7B model, strong coding and reasoning',
    },
    'qwen2-7b': {
        displayName: 'Qwen2 7B',
        filename: 'qwen2-7b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2-7B-Instruct-GGUF/resolve/main/qwen2-7b-instruct-q4_k_m.gguf',
        size: '4.4GB',
        minMemoryGB: 5,
        minCPUs: 2,
        description: "Alibaba's Qwen2 7B model, strong performance",
    },
    'llama3.1-8b': {
        displayName: 'Llama 3.1 8B',
        filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        size: '4.7GB',
        minMemoryGB: 6,
        minCPUs: 2,
        description: "Meta's latest 8B model, excellent all-around performance",
    },
    'gemma-7b': {
        displayName: 'Gemma 7B',
        filename: 'gemma-7b-it-Q4_K_M.gguf',
        url: 'https://huggingface.co/google/gemma-7b-it-GGUF/resolve/main/gemma-7b-it-Q4_K_M.gguf',
        size: '5.0GB',
        minMemoryGB: 6,
        minCPUs: 2,
        description: "Google's larger model, improved capabilities",
    },
    'codellama-7b': {
        displayName: 'Code Llama 7B',
        filename: 'codellama-7b-instruct.Q4_K_M.gguf',
        url: 'https://huggingface.co/TheBloke/CodeLlama-7B-Instruct-GGUF/resolve/main/codellama-7b-instruct.Q4_K_M.gguf',
        size: '3.8GB',
        minMemoryGB: 5,
        minCPUs: 2,
        description: 'Specialized for code generation and understanding',
    },
};

/**
 * Resolves the project root directory.
 * In development: process.cwd() (the sulla-desktop repo root).
 * In production (packaged): app.getPath('userData') — a writable
 * per-user directory on every platform:
 *   macOS:   ~/Library/Application Support/<appName>
 *   Windows: %APPDATA%/<appName>
 *   Linux:   ~/.config/<appName>
 */
function getProjectRoot(): string {
    try {
        const { app } = require('electron');
        if (app?.isPackaged) {
            return app.getPath('userData');
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
 * Detect whether an NVIDIA GPU is likely present (best-effort).
 */
function hasNvidiaGpu(): boolean {
    try {
        execSync('nvidia-smi', { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Detect GPU capability for the current platform (used when binaries are
 * already installed and we skipped getAssetPattern).
 */
function detectGpuCapability(): boolean {
    const platform = os.platform();
    if (platform === 'darwin') return true; // Metal always available
    return hasNvidiaGpu();
}

/** Track whether we downloaded a GPU-accelerated build */
let _isGpuBuild = false;
export function isGpuBuild(): boolean { return _isGpuBuild; }

/**
 * Determine the correct GitHub release asset name for this platform + arch.
 * Prefers CUDA builds on Linux/Windows when an NVIDIA GPU is detected.
 */
function getAssetPattern(tag: string): { name: string; ext: 'tar.gz' | 'zip' } | null {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'darwin') {
        // macOS always ships with Metal support in the standard build
        const suffix = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
        _isGpuBuild = true; // Metal is always available
        return { name: `llama-${tag}-bin-${suffix}.tar.gz`, ext: 'tar.gz' };
    }

    if (platform === 'linux') {
        const nvidia = hasNvidiaGpu();
        if (arch === 'arm64') {
            // ARM64 Linux — CPU only (no official CUDA ARM builds)
            _isGpuBuild = false;
            return { name: `llama-${tag}-bin-ubuntu-arm64.tar.gz`, ext: 'tar.gz' };
        }
        if (nvidia) {
            _isGpuBuild = true;
            return { name: `llama-${tag}-bin-ubuntu-x64-cuda.tar.gz`, ext: 'tar.gz' };
        }
        _isGpuBuild = false;
        return { name: `llama-${tag}-bin-ubuntu-x64.tar.gz`, ext: 'tar.gz' };
    }

    if (platform === 'win32') {
        const nvidia = hasNvidiaGpu();
        if (nvidia) {
            const suffix = arch === 'arm64' ? 'win-cuda-arm64' : 'win-cuda-x64';
            _isGpuBuild = true;
            return { name: `llama-${tag}-bin-${suffix}.zip`, ext: 'zip' };
        }
        const suffix = arch === 'arm64' ? 'win-cpu-arm64' : 'win-cpu-x64';
        _isGpuBuild = false;
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
 * Stream an HTTPS GET to a file on disk (for large model downloads).
 * Follows redirects just like httpGet.
 */
function httpGetToFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const makeRequest = (requestUrl: string, remainingRedirects: number) => {
            if (remainingRedirects <= 0) {
                return reject(new Error('Too many redirects'));
            }
            const mod = requestUrl.startsWith('https') ? https : http;
            const req = mod.get(requestUrl, { headers: { 'User-Agent': 'sulla-desktop' } }, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return makeRequest(res.headers.location, remainingRedirects - 1);
                }
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
                }
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
                res.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
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
    private _serverProcess: ChildProcess | null = null;
    private _serverRunning = false;
    private _activeModel: string | null = null;

    /** Paths exposed for other services */
    get llmRoot(): string { return getLlmRoot(); }
    get llamaCppDir(): string { return getLlamaCppDir(); }
    get modelsDir(): string { return getModelsDir(); }
    get trainingDir(): string { return getTrainingDir(); }

    get installedTag(): string | null { return this._installedTag; }
    get isReady(): boolean { return this._ready; }
    get isServerRunning(): boolean { return this._serverRunning; }
    get activeModel(): string | null { return this._activeModel; }
    get serverPort(): number { return LLAMA_SERVER_PORT; }
    get serverBaseUrl(): string { return `http://127.0.0.1:${LLAMA_SERVER_PORT}`; }

    /**
     * Resolve the absolute path to a llama.cpp binary (e.g. 'llama-server').
     * Returns null if not installed.
     */
    getBinaryPath(name: string): string | null {
        return findBinary(name);
    }

    /**
     * Get the absolute path to a downloaded model GGUF file.
     * Returns null if the model file doesn't exist on disk.
     */
    getModelPath(modelKey: string): string | null {
        const entry = GGUF_MODELS[modelKey];
        if (!entry) return null;
        const p = path.join(getModelsDir(), entry.filename);
        return fs.existsSync(p) ? p : null;
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
            _isGpuBuild = detectGpuCapability();
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

    /**
     * Download a GGUF model file into the models directory.
     * No-ops if the model file already exists on disk.
     *
     * @param modelKey Key from the GGUF_MODELS registry (e.g. 'qwen2-0.5b')
     * @returns Absolute path to the downloaded .gguf file
     */
    async downloadModel(modelKey: string): Promise<string> {
        const entry = GGUF_MODELS[modelKey];
        if (!entry) {
            throw new Error(`${LOG_PREFIX} Unknown model key: ${modelKey}`);
        }

        const destPath = path.join(getModelsDir(), entry.filename);

        if (fs.existsSync(destPath)) {
            const stat = fs.statSync(destPath);
            console.log(`${LOG_PREFIX} Model ${entry.displayName} already exists (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            return destPath;
        }

        console.log(`${LOG_PREFIX} Downloading model ${entry.displayName} from ${entry.url} ...`);

        // Stream to a temp file then rename — avoids partial files on crash
        const tmpPath = destPath + '.tmp';
        try {
            await httpGetToFile(entry.url, tmpPath);
            fs.renameSync(tmpPath, destPath);
            const stat = fs.statSync(destPath);
            console.log(`${LOG_PREFIX} Model ${entry.displayName} downloaded (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        } catch (err) {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw err;
        }

        return destPath;
    }

    /**
     * Start llama-server with the given model on port 30114.
     * If a server is already running it will be stopped first.
     *
     * @param modelPath Absolute path to the .gguf model file
     * @param port      Port to listen on (default: LLAMA_SERVER_PORT)
     */
    async startServer(modelPath: string, port: number = LLAMA_SERVER_PORT): Promise<void> {
        if (this._serverRunning) {
            console.log(`${LOG_PREFIX} Server already running, stopping first...`);
            await this.stopServer();
        }

        const serverBin = findBinary('llama-server');
        if (!serverBin) {
            throw new Error(`${LOG_PREFIX} llama-server binary not found — run ensure() first`);
        }

        if (!fs.existsSync(modelPath)) {
            throw new Error(`${LOG_PREFIX} Model file not found: ${modelPath}`);
        }

        console.log(`${LOG_PREFIX} Starting llama-server on port ${port} with model ${modelPath}`);

        const args = [
            '--model', modelPath,
            '--port', String(port),
            '--host', '127.0.0.1',
            '--ctx-size', '32768',
        ];

        // Only offload to GPU if we have a GPU-accelerated build
        if (_isGpuBuild) {
            args.push('--n-gpu-layers', '999');
        }

        const proc = spawn(serverBin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        this._serverProcess = proc;

        proc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8').trim();
            if (text) console.log(`${LOG_PREFIX} [server] ${text}`);
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8').trim();
            if (text) console.log(`${LOG_PREFIX} [server:err] ${text}`);
        });

        proc.on('close', (code) => {
            console.log(`${LOG_PREFIX} llama-server exited with code ${code}`);
            this._serverRunning = false;
            this._serverProcess = null;
        });

        proc.on('error', (err) => {
            console.error(`${LOG_PREFIX} llama-server spawn error:`, err);
            this._serverRunning = false;
            this._serverProcess = null;
        });

        // Wait for the server to become responsive
        await this.waitForReady(port);
        this._serverRunning = true;
        this._activeModel = path.basename(modelPath);
        console.log(`${LOG_PREFIX} llama-server is ready on http://127.0.0.1:${port}`);
    }

    /**
     * Stop the running llama-server process.
     */
    async stopServer(): Promise<void> {
        if (!this._serverProcess) {
            this._serverRunning = false;
            return;
        }

        console.log(`${LOG_PREFIX} Stopping llama-server (pid ${this._serverProcess.pid})...`);

        // On Windows, SIGTERM is translated to TerminateProcess by Node.
        // On Unix, send SIGTERM for graceful shutdown.
        this._serverProcess.kill('SIGTERM');

        // Give it 5 seconds to exit gracefully, then force-kill
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                if (this._serverProcess) {
                    console.log(`${LOG_PREFIX} Force-killing llama-server`);
                    if (os.platform() === 'win32') {
                        // On Windows, use taskkill for reliable forceful termination
                        try {
                            execSync(`taskkill /pid ${this._serverProcess.pid} /T /F`, { stdio: 'pipe' });
                        } catch { /* process may already be gone */ }
                    } else {
                        this._serverProcess.kill('SIGKILL');
                    }
                }
                resolve();
            }, 5000);

            if (this._serverProcess) {
                this._serverProcess.on('close', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            } else {
                clearTimeout(timeout);
                resolve();
            }
        });

        this._serverProcess = null;
        this._serverRunning = false;
        this._activeModel = null;
        console.log(`${LOG_PREFIX} llama-server stopped`);
    }

    /**
     * Poll the server health endpoint until it responds (max 60s).
     */
    private async waitForReady(port: number, timeoutMs: number = 60000): Promise<void> {
        const start = Date.now();
        const url = `http://127.0.0.1:${port}/health`;

        while (Date.now() - start < timeoutMs) {
            try {
                const res = await new Promise<number>((resolve, reject) => {
                    const req = http.get(url, (r) => {
                        r.resume();
                        resolve(r.statusCode ?? 0);
                    });
                    req.on('error', reject);
                    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (res === 200) return;
            } catch {
                // Not ready yet
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error(`${LOG_PREFIX} llama-server did not become ready within ${timeoutMs / 1000}s`);
    }
}
