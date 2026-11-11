import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceRegistry } from '@pkg/main/voice/inference/VoiceRegistry';
import { VoiceIdentifier } from '@pkg/main/voice/inference/VoiceIdentifier';
import { VoiceAssignmentCache } from '@pkg/pages/chat/services/VoiceAssignmentCache';
import { VoiceTranscriptTagger } from '@pkg/pages/chat/services/VoiceTranscriptTagger';

describe('VoiceRegistry', () => {
  const paths: string[] = [];
  afterEach(async() => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
  const make = async() => { const path = await mkdtemp(join(tmpdir(), 'voice-registry-')); paths.push(path); return { path, registry: new VoiceRegistry(path) }; };
  // risk: identity continuity and wrong-person assignment
  it('clusters at cosine >= .70, updates a normalized running centroid, and never reuses ids', async() => {
    const { registry } = await make();
    const first = await registry.assign([1, 0], false);
    const same = await registry.assign([0.8, 0.6], false);
    expect(same.voice.id).toBe(first.voice.id);
    expect(Math.hypot(...same.voice.centroid)).toBeCloseTo(1);
    const other = await registry.assign([-1, 0], false);
    expect(other.isNew).toBe(true);
    expect(other.voice.id).not.toBe(first.voice.id);
    await registry.forget(first.voice.id);
    expect((await registry.assign([1, 0], false)).voice.label).toBe('Voice 3');
  });
  // risk: owner attribution must not overclaim based on too few holds and must reevaluate
  it('promotes only at three holds and sixty percent, then reevaluates ownership', async() => {
    const { registry } = await make();
    const a = await registry.assign([1, 0], true); await registry.assign([1, 0], true);
    expect((await registry.list())[0].isOwner).toBe(false);
    await registry.assign([1, 0], true);
    expect((await registry.list())[0].isOwner).toBe(true);
    const b = await registry.assign([-1, 0], true); await registry.assign([-1, 0], true); await registry.assign([-1, 0], true); await registry.assign([-1, 0], true); await registry.assign([-1, 0], true);
    const voices = await registry.list();
    expect(voices.find(v => v.id === a.voice.id)?.isOwner).toBe(false);
    expect(voices.find(v => v.id === b.voice.id)?.isOwner).toBe(true);
  });
  // risk: deletion and eviction must not remove owner identity
  it('forgets individually/all and caps at fifty while retaining the owner', async() => {
    const path = await mkdtemp(join(tmpdir(), 'voice-registry-'));
    paths.push(path);
    const now = Date.now();
    const seeded = Array.from({ length: 50 }, (_, i) => ({ id: `voice-${i + 1}`, label: `Voice ${i + 1}`, centroid: Array.from({ length: 50 }, (_, j) => i === j ? 1 : 0), turns: 1, holdToTalkTurns: i === 0 ? 3 : 0, firstHeard: now, lastHeard: now + i, isOwner: i === 0 }));
    await writeFile(join(path, 'voice-registry.json'), JSON.stringify({ voices: seeded, nextId: 51, holdToTalkTotal: 3, enabled: true }));
    const registry = new VoiceRegistry(path);
    const owner = { voice: seeded[0] };
    await registry.assign(Array.from({ length: 50 }, (_, i) => i === 0 ? 0 : 1), false);
    const voices = await registry.list(); expect(voices).toHaveLength(50); expect(voices.some(v => v.id === owner.voice.id && v.isOwner)).toBe(true);
    const id = voices.find(v => v.id !== owner.voice.id)!.id; await registry.forget(id);
    await registry.setName(owner.voice.id, 'Sam');
    expect((await registry.list()).find(v => v.id === owner.voice.id)?.name).toBe('Sam');
    expect((await readFile(join(path, 'voice-registry.json'))).length).toBeGreaterThan(0);
    await registry.forgetAll(); expect(await registry.list()).toEqual([]);
  });

  // risk: stale hold counts can prevent a new owner after forgetting voices
  it('recomputes owner eligibility after forget and forgetAll', async() => {
    const { registry } = await make();
    const old = await registry.assign([1, 0], true);
    await registry.assign([1, 0], true);
    const survivor = await registry.assign([-1, 0], true);
    await registry.assign([-1, 0], true);
    await registry.assign([-1, 0], true);
    expect((await registry.list()).find(v => v.id === survivor.voice.id)?.isOwner).toBe(true);
    await registry.forget(old.voice.id);
    expect((await registry.list()).find(v => v.id === survivor.voice.id)?.isOwner).toBe(true);
    await registry.forgetAll();
    const fresh = await registry.assign([1, 0], true);
    await registry.assign([1, 0], true);
    await registry.assign([1, 0], true);
    expect((await registry.list()).find(v => v.id === fresh.voice.id)?.isOwner).toBe(true);
  });

  // risk: corrupted local data must not disable voice IDs for the whole session
  it('quarantines invalid JSON and starts with an empty registry', async() => {
    const path = await mkdtemp(join(tmpdir(), 'voice-registry-'));
    paths.push(path);
    const file = join(path, 'voice-registry.json');
    await writeFile(file, '{not json');
    const registry = new VoiceRegistry(path, () => 12345);
    expect((await registry.list())).toEqual([]);
    expect((await registry.assign([1, 0], false)).voice.id).toBe('voice-1');
    expect(await readFile(join(path, 'voice-registry.corrupt-12345.json'), 'utf8')).toBe('{not json');
  });

  // risk: user privacy; registry data must remain private and confined to local storage
  it('writes local identity data with owner-only permissions', async() => {
    const { registry, path } = await make();
    await registry.assign([1, 0], false);
    expect((await stat(join(path, 'voice-registry.json'))).mode & 0o777).toBe(0o600);
  });

  // risk: speech availability; short speech and missing models must fail open without waiting or blocking
  it('skips short utterances and fails open when model resolution fails', async() => {
    const { path } = await make();
    const resolve = vi.fn(async() => { throw new Error('model unavailable'); });
    const run = vi.fn(async() => [1, 0]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), getLogDir: vi.fn(), getLogPath: vi.fn() } as any;
    const identifier = new VoiceIdentifier({ resolve } as any, { run } as any, path, logger);
    await identifier.scoreTurn(Buffer.alloc(32_000, 0x20), true, 'vt_short');
    expect(resolve).not.toHaveBeenCalled();
    await identifier.scoreTurn(Buffer.alloc(48_000, 0x20), true, 'vt_model-failure');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // risk: incorrect speaker attribution; tags must be agent-only and display names/owner ordered consistently
  it('formats agent tags but returns the original text for the visible user bubble', () => {
    const tagger = new VoiceTranscriptTagger();
    const identity = { voiceId: 'voice-1', voiceLabel: 'Voice 1 — Jonathon', isOwner: true, score: 0.91 };
    const tagged = tagger.agentText('Hello', identity);
    expect(tagged).toBe('[Voice 1 (owner) — Jonathon] Hello');
    expect(tagger.userText(tagged, identity)).toBe('Hello');
    expect(tagger.agentText('Hi', { ...identity, voiceLabel: 'Voice 3', isOwner: false })).toBe('[Voice 3] Hi');
  });

  // risk: added turn latency; transcript dispatch must consume a ready ID immediately or remain untagged
  it('returns late assignments as absent and never waits for them', () => {
    let now = 0;
    const cache = new VoiceAssignmentCache(() => now);
    expect(cache.take('vt_late')).toBeUndefined();
    cache.put('vt_ready', { voiceId: 'voice-1', voiceLabel: 'Voice 1', isOwner: true, score: 0.8 });
    expect(cache.take('vt_ready')?.voiceId).toBe('voice-1');
    cache.put('vt_old', { voiceId: 'voice-2', voiceLabel: 'Voice 2', isOwner: false, score: 0.4 });
    now = 60_001;
    expect(cache.take('vt_old')).toBeUndefined();
  });
});
