/**
 * Kokoro on-device text-to-speech (free, private, offline).
 *
 * Same engine and model as Sulla Mobile's on-device voice: sherpa-onnx running
 * Kokoro-82M v1.0 (fp32 — int8 kernels are slower on Apple silicon). Bella is
 * the default voice.
 *
 * Inference runs in an Electron utilityProcess sidecar, never the main process:
 * sherpa synthesis is CPU-heavy (~0.6× real time at 4 threads on an M-series
 * Mac), and running it on the main thread would stall every IPC round-trip —
 * exactly the stutter this voice is meant to remove.
 *
 * The model (~350 MB) is downloaded once on first use from the pinned
 * sherpa-onnx GitHub release, sha256-verified, and extracted under
 * ~/.sulla/cache/voice-models/. Until it is ready, callers get
 * KokoroNotReadyError and fall back to the system voice.
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import paths from '@pkg/utils/paths';

// ─── Voices ─────────────────────────────────────────────────────

export interface KokoroVoice {
  /** Settings value stored in audioTtsVoice, e.g. 'af_bella'. */
  key:    string;
  /** Speaker id inside voices.bin (Kokoro v1.0 speaker table). */
  sid:    number;
  name:   string;
  accent: 'American' | 'British';
  gender: 'Female' | 'Male';
}

// Kokoro-82M v1.0 English speakers — sherpa-onnx speaker ids 0–27.
// Mirrors Sulla Mobile's table (src/services/voice/KokoroTts.ts).
const RAW: [number, string][] = [
  [2, 'af_bella'], [3, 'af_heart'], [6, 'af_nicole'], [9, 'af_sarah'], [0, 'af_alloy'],
  [1, 'af_aoede'], [4, 'af_jessica'], [5, 'af_kore'], [7, 'af_nova'], [8, 'af_river'],
  [10, 'af_sky'], [16, 'am_michael'], [13, 'am_eric'], [15, 'am_liam'], [11, 'am_adam'],
  [12, 'am_echo'], [14, 'am_fenrir'], [17, 'am_onyx'], [18, 'am_puck'], [19, 'am_santa'],
  [21, 'bf_emma'], [22, 'bf_isabella'], [20, 'bf_alice'], [23, 'bf_lily'], [26, 'bm_george'],
  [25, 'bm_fable'], [24, 'bm_daniel'], [27, 'bm_lewis'],
];

export const KOKORO_VOICES: KokoroVoice[] = RAW.map(([sid, key]) => ({
  key,
  sid,
  name:   key.slice(3).replace(/^./, c => c.toUpperCase()),
  accent: key[0] === 'b' ? 'British' : 'American',
  gender: key[1] === 'f' ? 'Female' : 'Male',
}));

export const KOKORO_DEFAULT_VOICE = 'af_bella';

export function kokoroVoiceFor(key: string | null | undefined): KokoroVoice {
  return KOKORO_VOICES.find(v => v.key === key) ??
    KOKORO_VOICES.find(v => v.key === KOKORO_DEFAULT_VOICE)!;
}

// ─── Model ──────────────────────────────────────────────────────

const MODEL = {
  archive:  'kokoro-multi-lang-v1_0',
  url:      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  bytes:    349_906_910,
  sha256:   'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
  required: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'espeak-ng-data'],
};

export type KokoroPhase = 'missing' | 'downloading' | 'extracting' | 'ready' | 'error';

export interface KokoroStatus {
  phase:    KokoroPhase;
  /** 0..1 within the current phase. */
  progress: number;
  error?:   string;
  /** Approximate download size, for the settings UI. */
  bytes:    number;
}

export class KokoroNotReadyError extends Error {
  constructor(phase: KokoroPhase) {
    super(`Kokoro voice model is not ready (${ phase })`);
    this.name = 'KokoroNotReadyError';
  }
}

function modelsRoot(): string {
  return path.join(paths.sullaConfig || path.join(os.homedir(), '.sulla'), 'cache', 'voice-models');
}

function modelDir(): string {
  return path.join(modelsRoot(), MODEL.archive);
}

function isInstalled(): boolean {
  return MODEL.required.every(f => fs.existsSync(path.join(modelDir(), f)));
}

let status: KokoroStatus = { phase: 'missing', progress: 0, bytes: MODEL.bytes };
const statusListeners = new Set<(s: KokoroStatus) => void>();
let downloadInflight: Promise<boolean> | null = null;

function setStatus(next: Partial<KokoroStatus>): void {
  status = { ...status, ...next };
  for (const l of statusListeners) {
    try { l(status) } catch { /* listener errors never break the download */ }
  }
}

export function getKokoroStatus(): KokoroStatus {
  if (status.phase !== 'downloading' && status.phase !== 'extracting') {
    if (isInstalled()) {
      if (status.phase !== 'ready') status = { ...status, phase: 'ready', progress: 1, error: undefined };
    } else if (status.phase === 'ready') {
      status = { ...status, phase: 'missing', progress: 0 };
    }
  }

  return status;
}

export function onKokoroStatus(cb: (s: KokoroStatus) => void): () => void {
  statusListeners.add(cb);

  return () => statusListeners.delete(cb);
}

/**
 * Download + verify + extract the model once. Concurrent callers share one
 * in-flight attempt. Resolves true when the model is installed.
 */
export function ensureKokoroModel(): Promise<boolean> {
  if (getKokoroStatus().phase === 'ready') return Promise.resolve(true);
  if (!downloadInflight) {
    downloadInflight = downloadModel().finally(() => { downloadInflight = null });
  }

  return downloadInflight;
}

async function downloadModel(): Promise<boolean> {
  const root = modelsRoot();
  const archivePath = path.join(root, `${ MODEL.archive }.tar.bz2.partial`);
  const stagingDir = path.join(root, `.${ MODEL.archive }.staging-${ process.pid }`);

  try {
    fs.mkdirSync(root, { recursive: true });
    setStatus({ phase: 'downloading', progress: 0, error: undefined });
    console.log('[Kokoro] downloading model', MODEL.url);

    const res = await fetch(MODEL.url);

    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${ res.status })`);

    const total = Number(res.headers.get('content-length')) || MODEL.bytes;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(archivePath);
    let received = 0;
    let lastEmit = 0;

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()));
        const now = Date.now();

        if (now - lastEmit > 250) {
          lastEmit = now;
          setStatus({ progress: Math.min(1, received / total) });
        }
      }
    } finally {
      await new Promise<void>(r => out.end(() => r()));
    }

    const digest = hash.digest('hex');

    if (digest !== MODEL.sha256) throw new Error('downloaded model failed its checksum');

    setStatus({ phase: 'extracting', progress: 0 });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['-xjf', archivePath, '-C', stagingDir], { timeout: 10 * 60_000 }, (err) => {
        if (err) reject(new Error(`extract failed: ${ err.message }`));
        else resolve();
      });
    });

    const extracted = path.join(stagingDir, MODEL.archive);

    if (!MODEL.required.every(f => fs.existsSync(path.join(extracted, f)))) {
      throw new Error('extracted model is missing required files');
    }
    fs.rmSync(modelDir(), { recursive: true, force: true });
    fs.renameSync(extracted, modelDir());
    console.log('[Kokoro] model ready at', modelDir());
    setStatus({ phase: 'ready', progress: 1 });

    return true;
  } catch (err: any) {
    console.warn('[Kokoro] model download failed:', err?.message ?? err);
    setStatus({ phase: 'error', progress: 0, error: String(err?.message ?? err) });

    return false;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ─── Text cleanup ───────────────────────────────────────────────

/**
 * Strip markup Kokoro would otherwise read aloud ("asterisk asterisk") or
 * choke on. The voice prompt already asks for plain speech; this is the net.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── WAV encoding ───────────────────────────────────────────────

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));

    buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF), 44 + i * 2);
  }

  return buf;
}

// ─── Sidecar ────────────────────────────────────────────────────

interface Pending {
  resolve: (r: { samples: Float32Array; sampleRate: number }) => void;
  reject:  (e: Error) => void;
}

let child: Electron.UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getAppRoot(): string {
  const { app } = require('electron') as typeof import('electron');
  let dir = app.getAppPath();

  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(`${ dir }.unpacked`, 'node_modules', 'sherpa-onnx-node'))) return `${ dir }.unpacked`;
    if (fs.existsSync(path.join(dir, 'node_modules', 'sherpa-onnx-node'))) return dir;
    dir = path.dirname(dir);
  }

  return app.getAppPath();
}

function getSidecarPath(): string {
  const dir = path.join(paths.sullaConfig || path.join(os.homedir(), '.sulla'), 'cache', 'kokoro');

  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'sidecar.cjs');

  fs.writeFileSync(p, SIDECAR_SOURCE);

  return p;
}

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getChild(): Electron.UtilityProcess {
  if (child) return child;

  const { utilityProcess } = require('electron') as typeof import('electron');
  // Leave cores for the app and the agent: 4 threads was fastest in measurement
  // on a 4-performance-core Mac; more threads got slower under load.
  const threads = Math.max(1, Math.min(4, os.cpus().length - 1));
  const proc = utilityProcess.fork(getSidecarPath(), [], {
    serviceName: 'sulla-kokoro-tts',
    stdio:       ['ignore', 'pipe', 'pipe'],
    env:         {
      ...process.env,
      SULLA_KOKORO_APP_ROOT:  getAppRoot(),
      SULLA_KOKORO_MODEL_DIR: modelDir(),
      SULLA_KOKORO_THREADS:   String(threads),
    },
  });

  proc.stdout?.on('data', (d: Buffer) => console.log(`[Kokoro][sidecar] ${ d.toString().trim() }`));
  proc.stderr?.on('data', (d: Buffer) => console.error(`[Kokoro][sidecar:stderr] ${ d.toString().trim() }`));
  proc.on('message', (msg: any) => {
    if (msg?.bootError) {
      console.error(`[Kokoro] sidecar boot failure: ${ msg.bootError }`);

      return;
    }
    const p = pending.get(msg?.id);

    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) {
      const samples = msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples);

      p.resolve({ samples, sampleRate: msg.sampleRate });
    } else {
      p.reject(new Error(msg.error || 'kokoro synthesis failed'));
    }
  });
  proc.on('exit', (code) => {
    console.warn(`[Kokoro] sidecar exited (code ${ code })`);
    if (child === proc) child = null;
    failAll(new Error('kokoro sidecar exited'));
  });
  child = proc;

  return proc;
}

function request(msg: Record<string, unknown>): Promise<{ samples: Float32Array; sampleRate: number }> {
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getChild().postMessage({ ...msg, id });
  });
}

/** Load the model ahead of the first reply (sidecar boot + ~1s model load + graph warm-up). */
export function warmKokoro(): void {
  if (getKokoroStatus().phase !== 'ready') {
    void ensureKokoroModel();

    return;
  }
  request({ type: 'warm' }).catch(() => { /* warm is best-effort */ });
}

/** Drop queued (not yet started) synthesis jobs — used when playback is stopped. */
export function cancelKokoro(): void {
  if (child) child.postMessage({ type: 'cancel' });
}

/**
 * Synthesize one utterance to a 16-bit mono WAV. Throws KokoroNotReadyError
 * (and starts the one-time download) when the model is not installed yet.
 */
export async function synthesizeKokoro(text: string, voiceKey?: string | null, speed = 1): Promise<Buffer> {
  const phase = getKokoroStatus().phase;

  if (phase !== 'ready') {
    void ensureKokoroModel();
    throw new KokoroNotReadyError(phase);
  }
  const clean = cleanForSpeech(text);

  if (!clean) throw new Error('nothing speakable in text');
  const voice = kokoroVoiceFor(voiceKey);
  const started = Date.now();
  const audio = await request({ type: 'synth', text: clean, sid: voice.sid, speed });
  const seconds = audio.samples.length / audio.sampleRate;

  console.log(`[Kokoro] synth ${ clean.length } chars → ${ seconds.toFixed(2) }s audio in ${ Date.now() - started }ms (${ voice.key })`);

  return encodeWav(audio.samples, audio.sampleRate);
}

export function disposeKokoro(): void {
  if (child) {
    try { child.kill() } catch { /* already gone */ }
    child = null;
  }
  failAll(new Error('kokoro disposed'));
}

// ─── Inline sidecar source ──────────────────────────────────────
// Plain CommonJS, written to ~/.sulla/cache/kokoro/sidecar.cjs at spawn time
// and run as an Electron utilityProcess (same pattern as the file-search
// sidecar). It owns the sherpa-onnx engine and runs one synthesis at a time,
// in request order, so the next sentence renders while the current one plays.

const SIDECAR_SOURCE = `'use strict';
// sulla kokoro sidecar (generated — source of truth is main/voice/kokoroTts.ts)
const path = require('path');
const { createRequire } = require('module');

function reportFatal(prefix, err) {
  try { process.parentPort.postMessage({ bootError: prefix + ': ' + String((err && err.stack) || err) }); } catch (e) {}
  try { console.error('[kokoro-sidecar] ' + prefix + ':', (err && err.stack) || err); } catch (e) {}
  process.exit(1);
}
process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => reportFatal('unhandledRejection', err));

const APP_ROOT = process.env.SULLA_KOKORO_APP_ROOT;
const MODEL_DIR = process.env.SULLA_KOKORO_MODEL_DIR;
const THREADS = Number(process.env.SULLA_KOKORO_THREADS) || 4;

let sherpa;
try {
  sherpa = createRequire(path.join(APP_ROOT, 'package.json'))('sherpa-onnx-node');
} catch (err) {
  reportFatal('load sherpa-onnx-node (appRoot=' + APP_ROOT + ')', err);
}

let ttsPromise = null;
function getTts() {
  if (!ttsPromise) {
    const started = Date.now();
    ttsPromise = sherpa.OfflineTts.createAsync({
      model: {
        kokoro: {
          model:   path.join(MODEL_DIR, 'model.onnx'),
          voices:  path.join(MODEL_DIR, 'voices.bin'),
          tokens:  path.join(MODEL_DIR, 'tokens.txt'),
          dataDir: path.join(MODEL_DIR, 'espeak-ng-data'),
          lexicon: path.join(MODEL_DIR, 'lexicon-us-en.txt'),
          lang:    'en-us',
        },
        numThreads: THREADS,
        provider:   'cpu',
        debug:      0,
      },
      maxNumSentences: 1,
    }).then((tts) => {
      console.log('model loaded in ' + (Date.now() - started) + 'ms, threads=' + THREADS);
      return tts;
    }, (err) => { ttsPromise = null; throw err; });
  }
  return ttsPromise;
}

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const tts = await getTts();
        const text = job.type === 'warm' ? 'Ready.' : job.text;
        const audio = await tts.generateAsync({ text: text, sid: job.type === 'warm' ? 2 : job.sid, speed: job.speed || 1 });
        if (job.type === 'warm') {
          process.parentPort.postMessage({ id: job.id, ok: true, samples: new Float32Array(0), sampleRate: audio.sampleRate });
        } else {
          process.parentPort.postMessage({ id: job.id, ok: true, samples: audio.samples, sampleRate: audio.sampleRate });
        }
      } catch (err) {
        process.parentPort.postMessage({ id: job.id, ok: false, error: String((err && err.message) || err) });
      }
    }
  } finally {
    busy = false;
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'cancel') {
    while (queue.length) {
      const job = queue.shift();
      process.parentPort.postMessage({ id: job.id, ok: false, error: 'cancelled' });
    }
    return;
  }
  queue.push(msg);
  pump();
});
`;
