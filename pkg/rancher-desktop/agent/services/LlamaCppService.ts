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
    sizeBytes: number;
    minMemoryGB: number;
    minCPUs: number;
    description: string;
    /** Unsloth HuggingFace repo ID for training (e.g. 'unsloth/Qwen3.5-9B'). */
    trainingRepo?: string;
}

export const GGUF_MODELS: Record<string, GGUFModelEntry> = {
    'qwen3.5-9b': {
        displayName: 'Qwen3.5 9B',
        filename: 'Qwen3.5-9B-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
        size: '5.6GB',
        sizeBytes: 5_600_000_000,
        minMemoryGB: 8,
        minCPUs: 4,
        description: "Qwen3.5 9B — latest generation, strong reasoning default",
        trainingRepo: 'unsloth/Qwen3.5-9B',
    },
    'qwen3.5-4b': {
        displayName: 'Qwen3.5 4B',
        filename: 'Qwen3.5-4B-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
        size: '2.7GB',
        sizeBytes: 2_700_000_000,
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Qwen3.5 4B — balanced performance and speed",
        trainingRepo: 'unsloth/Qwen3.5-4B',
    },
    'qwen3.5-0.8b': {
        displayName: 'Qwen3.5 0.8B',
        filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
        size: '600MB',
        sizeBytes: 600_000_000,
        minMemoryGB: 1,
        minCPUs: 1,
        description: "Qwen3.5 0.8B — fast and lightweight",
        trainingRepo: 'unsloth/Qwen3.5-0.8B',
    },
    'qwen2-1.5b': {
        displayName: 'Qwen2 1.5B',
        filename: 'qwen2-1_5b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2-1.5B-Instruct-GGUF/resolve/main/qwen2-1_5b-instruct-q4_k_m.gguf',
        size: '1.0GB',
        sizeBytes: 1_000_000_000,
        minMemoryGB: 2,
        minCPUs: 2,
        description: "Alibaba's Qwen2 model, efficient for basic tasks",
    },
    'phi3-mini': {
        displayName: 'Phi-3 Mini',
        filename: 'Phi-3-mini-4k-instruct-q4.gguf',
        url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
        size: '2.2GB',
        sizeBytes: 2_200_000_000,
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Microsoft's efficient 3.8B model, great reasoning capabilities",
    },
    'gemma-2b': {
        displayName: 'Gemma 2B',
        filename: 'gemma-2b-it-Q4_K_M.gguf',
        url: 'https://huggingface.co/google/gemma-2b-it-GGUF/resolve/main/gemma-2b-it-Q4_K_M.gguf',
        size: '1.7GB',
        sizeBytes: 1_700_000_000,
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Google's lightweight model, good general performance",
    },
    'llama3.2-1b': {
        displayName: 'Llama 3.2 1B',
        filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        size: '1.3GB',
        sizeBytes: 1_300_000_000,
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Meta's smallest Llama 3.2, efficient and capable",
    },
    'llama3.2-3b': {
        displayName: 'Llama 3.2 3B',
        filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        size: '2.0GB',
        sizeBytes: 2_000_000_000,
        minMemoryGB: 4,
        minCPUs: 2,
        description: "Meta's compact Llama 3.2, balanced performance",
    },
    'mistral-7b': {
        displayName: 'Mistral 7B',
        filename: 'mistral-7b-instruct-v0.3.Q4_K_M.gguf',
        url: 'https://huggingface.co/MistralAI/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/mistral-7b-instruct-v0.3.Q4_K_M.gguf',
        size: '4.1GB',
        sizeBytes: 4_100_000_000,
        minMemoryGB: 5,
        minCPUs: 2,
        description: 'Excellent 7B model, strong coding and reasoning',
    },
    'qwen2-7b': {
        displayName: 'Qwen2 7B',
        filename: 'qwen2-7b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2-7B-Instruct-GGUF/resolve/main/qwen2-7b-instruct-q4_k_m.gguf',
        size: '4.4GB',
        sizeBytes: 4_400_000_000,
        minMemoryGB: 5,
        minCPUs: 2,
        description: "Alibaba's Qwen2 7B model, strong performance",
    },
    'llama3.1-8b': {
        displayName: 'Llama 3.1 8B',
        filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        size: '4.7GB',
        sizeBytes: 4_700_000_000,
        minMemoryGB: 6,
        minCPUs: 2,
        description: "Meta's latest 8B model, excellent all-around performance",
    },
    'gemma-7b': {
        displayName: 'Gemma 7B',
        filename: 'gemma-7b-it-Q4_K_M.gguf',
        url: 'https://huggingface.co/google/gemma-7b-it-GGUF/resolve/main/gemma-7b-it-Q4_K_M.gguf',
        size: '5.0GB',
        sizeBytes: 5_000_000_000,
        minMemoryGB: 6,
        minCPUs: 2,
        description: "Google's larger model, improved capabilities",
    },
    'codellama-7b': {
        displayName: 'Code Llama 7B',
        filename: 'codellama-7b-instruct.Q4_K_M.gguf',
        url: 'https://huggingface.co/TheBloke/CodeLlama-7B-Instruct-GGUF/resolve/main/codellama-7b-instruct.Q4_K_M.gguf',
        size: '3.8GB',
        sizeBytes: 3_800_000_000,
        minMemoryGB: 5,
        minCPUs: 2,
        description: 'Specialized for code generation and understanding',
    },
};

/**
 * Always use app.getPath('userData') for the llm directory so that:
 *   - It is writable on all platforms (including signed macOS .app bundles)
 *   - The Lima VM can access it (macOS: ~/Library/Application Support/rancher-desktop/)
 *   - Training data written inside the VM is visible to the host and vice-versa
 *
 * Resolves to:
 *   macOS:   ~/Library/Application Support/rancher-desktop/
 *   Windows: %APPDATA%/rancher-desktop/
 *   Linux:   ~/.config/rancher-desktop/
 */
function getProjectRoot(): string {
    try {
        const { app } = require('electron');
        return app.getPath('userData');
    } catch {
        // Not in Electron context (e.g. tests) — fall back to cwd
        return process.cwd();
    }
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
                // Follow redirects (resolve relative Location headers)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, requestUrl).href;
                    return makeRequest(next, remainingRedirects - 1);
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
function httpGetToFile(url: string, destPath: string, onProgress?: (received: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const makeRequest = (requestUrl: string, remainingRedirects: number) => {
            if (remainingRedirects <= 0) {
                return reject(new Error('Too many redirects'));
            }
            const mod = requestUrl.startsWith('https') ? https : http;
            const req = mod.get(requestUrl, { headers: { 'User-Agent': 'sulla-desktop' } }, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, requestUrl).href;
                    return makeRequest(next, remainingRedirects - 1);
                }
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
                }
                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let receivedBytes = 0;
                const file = fs.createWriteStream(destPath);
                res.on('data', (chunk: Buffer) => {
                    receivedBytes += chunk.length;
                    file.write(chunk);
                    if (onProgress && totalBytes > 0) {
                        onProgress(receivedBytes, totalBytes);
                    }
                });
                res.on('end', () => { file.end(); });
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
                res.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
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
// Training script paths — scripts live in the root-level training/ folder.
// At runtime they are invoked via the training venv Python pointing at
// the source files in this project (resolved via getTrainingScriptsDir()).
// ---------------------------------------------------------------------------

/** Resolve the root-level training/ directory containing our Python training scripts. */
export function getTrainingScriptsDir(): string {
    // __dirname is not available in the bundled ESM background runtime.
    // Resolve against Electron app paths first, then fall back to cwd.
    const candidates: string[] = [];

    try {
        const { app } = require('electron');
        const appPath = app?.getAppPath?.() as string | undefined;

        if (appPath) {
            candidates.push(path.join(appPath, 'training'));
            candidates.push(path.resolve(appPath, '..', 'training'));
            candidates.push(path.resolve(appPath, '..', '..', 'training'));
        }

        if (process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'training'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'training'));
        }
    } catch {
        // Not running in Electron main process; use cwd fallback below.
    }

    candidates.push(path.resolve(process.cwd(), 'training'));

    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    // Last resort (non-existent is still useful for diagnostics/logging).
    return candidates[0] || path.resolve(process.cwd(), 'training');
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
    private _contextSize: number = 4096;

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
    get contextSize(): number { return this._contextSize; }

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
     * Get the directory path where a training model would be stored.
     * Each training repo gets its own subdirectory inside llm/training/.
     * Returns null if the model has no trainingRepo defined.
     */
    getTrainingModelPath(modelKey: string): string | null {
        const entry = GGUF_MODELS[modelKey];
        if (!entry?.trainingRepo) return null;
        // e.g. 'unsloth/Qwen3.5-9B' → 'Qwen3.5-9B'
        const dirName = entry.trainingRepo.split('/').pop()!;
        const p = path.join(getTrainingDir(), dirName);
        // Verify download completed successfully via marker file
        const marker = path.join(p, '.download-complete');
        return fs.existsSync(marker) ? p : null;
    }

    /**
     * Download an Unsloth training model from HuggingFace into llm/training/.
     * Uses the HuggingFace snapshot download API (downloads all files in the repo).
     * No-ops if the training model directory already exists.
     *
     * @param modelKey Key from GGUF_MODELS (e.g. 'qwen3.5-9b')
     * @returns Absolute path to the training model directory
     */
    async downloadTrainingModel(
        modelKey: string,
        logPath?: string,
        onProgress?: (fileIndex: number, fileCount: number, fileName: string, bytesReceived: number, bytesTotal: number) => void,
    ): Promise<string> {
        const entry = GGUF_MODELS[modelKey];
        if (!entry) {
            throw new Error(`${LOG_PREFIX} Unknown model key: ${modelKey}`);
        }
        if (!entry.trainingRepo) {
            throw new Error(`${LOG_PREFIX} Model ${modelKey} has no training repo defined`);
        }

        const log = (msg: string) => {
            console.log(`${LOG_PREFIX} ${msg}`);
            if (logPath) fs.appendFileSync(logPath, `${msg}\n`, 'utf-8');
        };

        // e.g. 'unsloth/Qwen3.5-9B' → directory 'Qwen3.5-9B'
        const dirName = entry.trainingRepo.split('/').pop()!;
        const destDir = path.join(getTrainingDir(), dirName);

        const marker = path.join(destDir, '.download-complete');
        if (fs.existsSync(marker)) {
            log(`Training model ${entry.trainingRepo} already downloaded`);
            return destDir;
        }

        // Clean up any partial download
        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }

        fs.mkdirSync(destDir, { recursive: true });

        log(`Downloading training model ${entry.trainingRepo} ...`);

        // Fetch the file list from HuggingFace API
        const apiUrl = `https://huggingface.co/api/models/${entry.trainingRepo}/tree/main`;
        const listBuf = await httpGet(apiUrl, { 'User-Agent': 'sulla-desktop' });
        const files: Array<{ path: string; type: string }> = JSON.parse(listBuf.toString('utf-8'));

        const fileList = files.filter(f => f.type === 'file');
        log(`  ${fileList.length} files to download`);

        // Download each file (skip directories)
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];

            const fileUrl = `https://huggingface.co/${entry.trainingRepo}/resolve/main/${file.path}`;
            const fileDest = path.join(destDir, file.path);

            // Create subdirectories if needed
            const fileDir = path.dirname(fileDest);
            if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
            }

            log(`  [${i + 1}/${fileList.length}] ${file.path}`);
            await httpGetToFile(fileUrl, fileDest, (received, total) => {
                onProgress?.(i, fileList.length, file.path, received, total);
            });
        }

        // Mark download as complete
        fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
        log(`Training model ${entry.trainingRepo} downloaded to ${destDir}`);
        return destDir;
    }

    /**
     * Get the path to the Python virtual environment used for training.
     * Lives at llm/training/.venv/
     */
    get trainingVenvDir(): string { return path.join(getTrainingDir(), '.venv'); }

    /** Path to the feedback queue directory where conversations are written for training. */
    get feedbackQueueDir(): string { return path.join(getLlmRoot(), 'feedback_queue'); }

    /** Whether the training Python venv + deps are installed. */
    get isTrainingReady(): boolean {
        const venvPython = this.getTrainingPython();
        return venvPython !== null;
    }

    /**
     * Get the path to the Python binary inside the training venv.
     * Returns null if the venv doesn't exist.
     */
    getTrainingPython(): string | null {
        const venvDir = this.trainingVenvDir;
        const bin = os.platform() === 'win32'
            ? path.join(venvDir, 'Scripts', 'python.exe')
            : path.join(venvDir, 'bin', 'python');
        return fs.existsSync(bin) ? bin : null;
    }

    /**
     * Install the training system: creates a Python venv, installs unsloth + torch.
     * Platform-aware: uses MLX backend on macOS, CUDA on Linux/Windows.
     * No-ops if the venv already exists and has unsloth installed.
     */
    async installTrainingDeps(logPath?: string, onProgress?: (description: string, current: number, max: number) => void): Promise<void> {
        const venvDir = this.trainingVenvDir;
        const feedbackDir = this.feedbackQueueDir;

        const log = (msg: string) => {
            console.log(`${LOG_PREFIX} ${msg}`);
            if (logPath) fs.appendFileSync(logPath, `${msg}\n`, 'utf-8');
        };

        const progress = (description: string, current: number, max: number) => {
            onProgress?.(description, current, max);
        };

        // Ensure directories exist
        fs.mkdirSync(getTrainingDir(), { recursive: true });
        fs.mkdirSync(feedbackDir, { recursive: true });

        // Check if venv already has all required packages
        const existingPython = this.getTrainingPython();
        if (existingPython) {
            try {
                execSync(`"${existingPython}" -c "import unsloth; import fitz; import docx"`, { stdio: 'pipe' });
                log('Training deps already installed');
                progress('Training dependencies ready', 100, 100);
                return;
            } catch {
                log('Venv exists but required packages missing, recreating venv...');
                fs.rmSync(venvDir, { recursive: true, force: true });
            }
        }

        // Find system Python 3
        progress('Finding Python 3...', 5, 100);
        const python3 = this.findPython3();
        if (!python3) {
            throw new Error(`${LOG_PREFIX} Python 3 not found on this system — required for training`);
        }
        log(`Using system Python: ${python3}`);

        // Create venv
        progress('Creating Python virtual environment...', 10, 100);
        log(`Creating training venv at ${venvDir} ...`);
        execSync(`"${python3}" -m venv "${venvDir}"`, { stdio: 'pipe' });

        const venvPython = this.getTrainingPython()!;

        // Upgrade pip (stream output)
        progress('Upgrading pip...', 15, 100);
        log('Upgrading pip...');
        await this.spawnWithLog(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], logPath);

        // Install platform-specific deps
        const platform = os.platform();
        let packages: string[];

        if (platform === 'darwin') {
            // macOS: plain unsloth + mlx-lm for Apple Silicon fine-tuning + doc processing libs
            packages = ['unsloth', 'mlx-lm', 'torch', 'torchvision', 'torchaudio', 'pymupdf', 'python-docx', 'markdown'];
        } else {
            // Linux / Windows: CUDA backend + doc processing libs
            packages = ['unsloth', 'torch', 'torchvision', 'torchaudio', 'pymupdf', 'python-docx', 'markdown', '--extra-index-url', 'https://download.pytorch.org/whl/cu121'];
        }

        log('Installing training dependencies (this may take several minutes)...');
        log(`  Packages: ${packages.filter(p => !p.startsWith('--')).join(', ')}`);

        if (platform === 'darwin') {
            // macOS: install torch first, then unsloth --no-deps to avoid xformers (CUDA-only) build failure
            progress('Installing PyTorch (step 1/3)...', 20, 100);
            log('  Step 1/3: Installing PyTorch...');
            await this.spawnWithLog(venvPython, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio'], logPath, 600_000);

            progress('Installing Unsloth + MLX (step 2/3)...', 50, 100);
            log('  Step 2/3: Installing unsloth + mlx-lm...');
            await this.spawnWithLog(venvPython, ['-m', 'pip', 'install', '--no-deps', 'unsloth', 'unsloth_zoo'], logPath, 600_000);
            await this.spawnWithLog(venvPython, ['-m', 'pip', 'install', 'mlx-lm'], logPath, 600_000);

            progress('Installing document processing libs (step 3/3)...', 75, 100);
            log('  Step 3/3: Installing remaining deps + doc processing libs...');
            await this.spawnWithLog(venvPython, ['-m', 'pip', 'install',
                // unsloth runtime deps (--no-deps means we must supply them)
                'wheel', 'diffusers', 'msgspec', 'torchao',
                'peft', 'datasets', 'bitsandbytes',
                'trl', 'accelerate', 'huggingface_hub', 'hf_transfer',
                'sentencepiece', 'protobuf', 'tyro',
                // doc processing
                'pymupdf', 'python-docx', 'markdown',
            ], logPath, 600_000);
        } else {
            progress('Installing training dependencies...', 30, 100);
            await this.spawnWithLog(venvPython, ['-m', 'pip', 'install', ...packages], logPath, 600_000);
        }

        progress('Training dependencies installed', 100, 100);
        log('Training dependencies installed successfully');
    }

    /**
     * Spawn a process and stream its output to a log file in real-time.
     * Resolves on exit code 0, rejects otherwise.
     */
    private spawnWithLog(cmd: string, args: string[], logPath?: string, timeout?: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const { spawn: spawnProc } = require('child_process');
            const proc = spawnProc(cmd, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PIP_NO_CACHE_DIR: '1' },
            });

            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeout) {
                timer = setTimeout(() => {
                    proc.kill();
                    reject(new Error(`Process timed out after ${timeout}ms`));
                }, timeout);
            }

            let stderrBuf = '';
            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                console.log(text.trimEnd());
                if (logPath) fs.appendFileSync(logPath, text, 'utf-8');
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrBuf += text;
                console.error(text.trimEnd());
                if (logPath) fs.appendFileSync(logPath, text, 'utf-8');
            });
            proc.on('close', (code: number | null) => {
                if (timer) clearTimeout(timer);
                if (code === 0) resolve();
                else {
                    const tail = stderrBuf.slice(-500).trim();
                    reject(new Error(`Process exited with code ${code}${tail ? `\n${tail}` : ''}`));
                }
            });
            proc.on('error', (err: Error) => {
                if (timer) clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Find a working Python 3 binary on the system.
     */
    private findPython3(): string | null {
        const candidates = os.platform() === 'win32'
            ? ['python', 'python3', 'py -3']
            : ['python3', 'python'];

        for (const cmd of candidates) {
            try {
                const version = execSync(`${cmd} --version`, { stdio: 'pipe' }).toString().trim();
                if (version.includes('Python 3')) {
                    // Return the resolved path
                    if (os.platform() === 'win32') {
                        return execSync(`where ${cmd.split(' ')[0]}`, { stdio: 'pipe' }).toString().trim().split('\n')[0];
                    }
                    return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim();
                }
            } catch { /* not found */ }
        }
        return null;
    }

    /**
     * Set up the entire training system: venv, deps, document config, feedback queue.
     * Scripts live in agent/scripts/ as real project files — nothing is written out.
     * Safe to call on every startup — no-ops if everything is already in place.
     */
    async ensureTrainingSystem(modelKey: string, logPath?: string): Promise<void> {
        const log = (msg: string) => {
            console.log(`${LOG_PREFIX} ${msg}`);
            if (logPath) fs.appendFileSync(logPath, `${msg}\n`, 'utf-8');
        };

        log('Ensuring training system...');

        try {
            // 1. Install Python venv + unsloth + torch + doc libs
            await this.installTrainingDeps(logPath);

            // 2. Write default documents_config.json (only if not already present)
            this.writeDocumentsConfig();

            // 3. Download the Unsloth training model for the selected size
            const entry = GGUF_MODELS[modelKey];
            if (entry?.trainingRepo) {
                await this.downloadTrainingModel(modelKey, logPath);
            }

            log('Training system ready');
        } catch (err) {
            log(`Failed to set up training system: ${err}`);
            throw err;
        }
    }

    /**
     * Write a default documents_config.json if one doesn't already exist.
     * Users can edit this to point at their real folders.
     */
    private writeDocumentsConfig(): void {
        const configPath = path.join(getTrainingDir(), 'documents_config.json');
        if (fs.existsSync(configPath)) {
            return; // Don't overwrite user customizations
        }

        const homeDir = os.homedir();
        const defaultConfig = {
            folders: [
                path.join(homeDir, 'Documents'),
                path.join(homeDir, 'Projects'),
                path.join(homeDir, 'Notes'),
            ],
            file_types: ['.txt', '.md', '.pdf', '.docx'],
        };

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        console.log(`${LOG_PREFIX} Wrote default documents_config.json to ${configPath}`);
    }

    /**
     * Run the documents processor to scan for new/changed documents
     * and generate QA training pairs.
     */
    async processDocuments(): Promise<void> {
        const python = this.getTrainingPython();
        if (!python) {
            throw new Error(`${LOG_PREFIX} Training venv not installed — run ensureTrainingSystem() first`);
        }
        const script = path.join(getTrainingScriptsDir(), 'documents_processor.py');
        console.log(`${LOG_PREFIX} Running documents processor...`);
        execSync(`"${python}" "${script}" --llm-root "${getLlmRoot()}"`, {
            stdio: 'pipe',
            timeout: 300_000, // 5 min
        });
        console.log(`${LOG_PREFIX} Documents processing complete`);
    }

    /**
     * Run the full nightly training pipeline:
     *   1. Process documents (incremental scan → QA pairs)
     *   2. Run train_nightly.py (feedback + docs + replay → LoRA → GGUF)
     *
     * Call this from a scheduler (launchd / cron / Task Scheduler).
     */
    async runFullNightlyTraining(modelKey: string): Promise<void> {
        const entry = GGUF_MODELS[modelKey];
        if (!entry?.trainingRepo) {
            throw new Error(`${LOG_PREFIX} Model ${modelKey} has no training repo`);
        }

        const python = this.getTrainingPython();
        if (!python) {
            throw new Error(`${LOG_PREFIX} Training venv not installed`);
        }

        // 1. Process documents
        try {
            await this.processDocuments();
        } catch (err) {
            console.error(`${LOG_PREFIX} Document processing failed (continuing with training):`, err);
        }

        // 2. Run training
        const script = path.join(getTrainingScriptsDir(), 'train_nightly.py');
        console.log(`${LOG_PREFIX} Running nightly training with model ${entry.trainingRepo}...`);
        execSync(`"${python}" "${script}" --model "${entry.trainingRepo}" --llm-root "${getLlmRoot()}"`, {
            stdio: 'pipe',
            timeout: 3_600_000, // 1 hour
        });
        console.log(`${LOG_PREFIX} Nightly training complete`);
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

        // Calculate context size based on available system RAM and model file size
        const modelFileSize = fs.statSync(modelPath).size;
        this._contextSize = this.calculateContextSize(modelFileSize);
        console.log(`${LOG_PREFIX} Starting llama-server on port ${port} with model ${modelPath} (ctx=${this._contextSize})`);

        const args = [
            '--model', modelPath,
            '--port', String(port),
            '--host', '127.0.0.1',
            '--ctx-size', String(this._contextSize),
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
     * Calculate the optimal --ctx-size based on available system RAM and model weight.
     *
     * Formula:
     *   availableForContext = totalRAM - modelFileSize - 2GB (OS/app overhead)
     *   Each token of context costs ~2 bytes of KV cache for Q4 models (rough heuristic).
     *   Clamp result between 2048 and 131072 tokens, rounded down to nearest 1024.
     */
    private calculateContextSize(modelFileSizeBytes: number): number {
        const totalRamBytes = os.totalmem();
        const osOverhead = 2 * 1024 * 1024 * 1024; // 2 GB reserved for OS + app
        const availableBytes = totalRamBytes - modelFileSizeBytes - osOverhead;

        if (availableBytes <= 0) {
            console.warn(`${LOG_PREFIX} Very low available RAM, using minimum context size`);
            return 2048;
        }

        // KV cache cost: ~2 bytes per token for Q4_K_M quants (conservative estimate)
        const bytesPerToken = 2;
        let ctxSize = Math.floor(availableBytes / bytesPerToken);

        // Round down to nearest 1024
        ctxSize = Math.floor(ctxSize / 1024) * 1024;

        // Clamp
        const MIN_CTX = 2048;
        const MAX_CTX = 131072;
        ctxSize = Math.max(MIN_CTX, Math.min(MAX_CTX, ctxSize));

        console.log(`${LOG_PREFIX} RAM: ${(totalRamBytes / 1e9).toFixed(1)}GB, model: ${(modelFileSizeBytes / 1e9).toFixed(1)}GB, calculated ctx-size: ${ctxSize}`);
        return ctxSize;
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
