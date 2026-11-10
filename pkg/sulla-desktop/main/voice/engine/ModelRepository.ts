// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, Writable } from 'node:fs';
import { mkdir, rename, rm, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
export interface VoiceModel { id: string; url: string; sha256: string; sizeBytes: number }
export interface ModelManifest { defaults: VoiceModel[] }
export interface ModelFetchResponse { ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }
export interface ModelHttpClient { fetch(url: string, options: { headers?: Record<string, string> }): Promise<ModelFetchResponse> }
/** Installs pinned voice artifacts under an injected per-user directory and verifies integrity before use. */
export class ModelRepository {
  static async fromManifest(manifestPath: string, userDataPath: () => string, http: ModelHttpClient): Promise<ModelRepository> {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ModelManifest;
    return new ModelRepository(userDataPath, manifest, http);
  }
  constructor(private readonly userDataPath: () => string, private readonly manifest: ModelManifest, private readonly http: ModelHttpClient) {}
  async resolve(id: string, signal?: AbortSignal): Promise<string> {
    const model = this.manifest.defaults.find(item => item.id === id); if (!model) throw new Error(`Unknown voice model: ${id}`);
    const target = join(this.userDataPath(), 'voice-models', `${model.id}.model`); await mkdir(dirname(target), { recursive: true });
    if (await this.matches(target, model.sha256)) return target;
    const temp = `${target}.part`; let offset = 0;
    try { offset = (await stat(temp)).size; } catch { /* no partial artifact */ }
    const response = await this.http.fetch(model.url, { headers: offset ? { Range: `bytes=${offset}-` } : undefined });
    if (!response.ok || !response.body || (offset && response.status !== 206)) { await rm(temp, { force: true }); throw new Error(`Unable to download voice model ${id}: HTTP ${response.status}`); }
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temp, { flags: offset ? 'a' : 'w' }), { signal });
    const actual = await this.hash(temp);
    if (actual !== model.sha256) { await rm(temp, { force: true }); await rm(target, { force: true }); throw new Error(`SHA-256 mismatch for voice model ${id}`); }
    await rename(temp, target); return target;
  }
  private async matches(path: string, expected: string): Promise<boolean> { try { return await this.hash(path) === expected; } catch { return false; } }
  private async hash(path: string): Promise<string> { const hash = createHash('sha256'); await pipeline(createReadStream(path), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } })); return hash.digest('hex'); }
}
