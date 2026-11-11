// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it, vi } from 'vitest';
import { LocalUseCaseChangeNotifier, UseCaseSuggestionIndex, type UseCaseCatalogItem, type UseCaseType } from '../../../useCases/UseCaseSuggestionIndex';

/** Mutable published catalog; `gate` lets a test hold listPublished open to stage races. */
class FixtureCatalog {
  gate?: Promise<void>;
  failList = 0;
  listCalls = 0;
  constructor(public rows: UseCaseCatalogItem[]) {}
  async listPublished(): Promise<UseCaseCatalogItem[]> {
    this.listCalls++;
    const snapshot = [...this.rows];
    if (this.gate) await this.gate;
    if (this.failList > 0) { this.failList--; throw new Error('catalog offline'); }
    return snapshot;
  }
  async findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null> { return this.rows.find(row => row.type === type && row.slug === slug) ?? null; }
}
class FingerprintedCatalog extends FixtureCatalog {
  async fingerprint(): Promise<string> { return JSON.stringify(this.rows); }
}
/** Unit vectors along topic axes: same topic → cosine 1, different topic → 0. */
class TopicEmbedder {
  readonly dim = 4;
  embed(text: string): Float32Array {
    const v = new Float32Array(4);
    if (/calendar|meeting|schedule/.test(text)) v[0] = 1;
    else if (/mail|inbox/.test(text)) v[1] = 1;
    else if (/invoice|billing/.test(text)) v[2] = 1;
    else v[3] = 1;
    return v;
  }
}
const item = (slug: string, description: string, type: UseCaseType = 'skill'): UseCaseCatalogItem => ({ type, slug, title: slug, description });
const quietLogger = { info: () => {} };
const flush = async() => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const build = (source: FixtureCatalog, opts: { loader?: () => Promise<any>; notifier?: LocalUseCaseChangeNotifier; clock?: { t: number }; tuning?: Record<string, number> } = {}) => {
  const clock = opts.clock ?? { t: 0 };
  return new UseCaseSuggestionIndex(opts.loader ?? (async() => new TopicEmbedder()), source, opts.notifier ?? new LocalUseCaseChangeNotifier(quietLogger), quietLogger, () => clock.t, opts.tuning);
};

describe('UseCaseSuggestionIndex relevance', () => {
  it('returns nothing for a query unrelated to every use case', async() => {
    // risk: data accuracy — an unrelated message must not surface arbitrary use cases.
    const index = build(new FixtureCatalog([item('calendar-skill', 'calendar meetings'), item('mail-skill', 'mail inbox')]));
    expect(await index.suggest('invoice billing totals')).toEqual([]);
  });

  it('ranks the semantically closest use case first with a meaningful 0..1 score', async() => {
    // risk: data accuracy — score must reflect similarity, not a rank-fusion artifact.
    const index = build(new FixtureCatalog([item('mail-skill', 'mail inbox'), item('calendar-skill', 'calendar meetings')]));
    const [top, ...rest] = await index.suggest('schedule a meeting');
    expect(top.slug).toBe('calendar-skill');
    expect(top.reason).toBe('semantic match');
    expect(top.score).toBeGreaterThanOrEqual(index.thresholds.semantic);
    expect(top.score).toBeLessThanOrEqual(1);
    expect(rest).toEqual([]);
  });

  it('does not fall back to keyword hits while the embedder is healthy', async() => {
    // risk: data accuracy — keyword fallback is only for an unavailable embedder.
    // "inbox" appears literally in the calendar skill's text, but its vector is about calendars.
    const index = build(new FixtureCatalog([item('calendar-skill', 'calendar meetings, not your inbox')]));
    expect(await index.suggest('inbox zero')).toEqual([]);
    expect(index.mode).toBe('semantic');
  });

  it('uses keyword ranking only when the embedder is unavailable, still quiet for unrelated text', async() => {
    // risk: availability — suggestions keep working without model weights, without noise.
    const index = build(new FixtureCatalog([item('calendar-helper', 'calendar meeting workflow'), item('mail-helper', 'mail inbox')]), { loader: async() => { throw new Error('weights missing'); } });
    const rows = await index.suggest('calendar meeting');
    expect(rows.map(row => row.slug)).toEqual(['calendar-helper']);
    expect(rows[0].reason).toBe('keyword match');
    expect(index.mode).toBe('keyword');
    expect(await index.suggest('quarterly taxes')).toEqual([]);
  });

  it('switches back to semantic ranking once the embedder loads on retry', async() => {
    // risk: data accuracy — a transient weight-load failure must not pin keyword mode forever.
    const clock = { t: 0 };
    let fail = true;
    const index = build(new FixtureCatalog([item('calendar-skill', 'calendar meetings')]), { clock, loader: async() => { if (fail) throw new Error('busy'); return new TopicEmbedder(); }, tuning: { embedderRetryMs: 1000 } });
    expect((await index.suggest('calendar')).at(0)?.reason).toBe('keyword match');
    fail = false; clock.t = 1500;
    await index.suggest('calendar'); await flush();
    const rows = await index.suggest('schedule');
    expect(rows.map(row => [row.slug, row.reason])).toEqual([['calendar-skill', 'semantic match']]);
  });
});

describe('UseCaseSuggestionIndex filters', () => {
  it('applies allowedSlugs and types before the limit', async() => {
    // risk: permissions — team recall must only ever see allowed agents, and a filtered row must not consume the limit.
    const rows = [item('calendar-a', 'calendar meeting'), item('calendar-b', 'calendar meeting', 'agent'), item('calendar-c', 'calendar meeting', 'agent')];
    const index = build(new FixtureCatalog(rows));
    expect((await index.suggest('calendar', { allowedSlugs: ['calendar-c'], limit: 1 })).map(row => row.slug)).toEqual(['calendar-c']);
    expect((await index.suggest('calendar', { types: ['agent'], limit: 5 })).map(row => row.slug).sort()).toEqual(['calendar-b', 'calendar-c']);
    expect(await index.suggest('calendar', { allowedSlugs: [] })).toEqual([]);
  });

  it('bounds the limit and rejects malformed filters', async() => {
    // risk: data accuracy — oversized or invalid requests must not return unbounded or wrongly-typed rows.
    const index = build(new FixtureCatalog(Array.from({ length: 80 }, (_, i) => item(`calendar-${ i }`, 'calendar meeting'))));
    expect(await index.suggest('calendar', { limit: 1000 })).toHaveLength(50);
    expect(await index.suggest('calendar', { limit: 0 })).toHaveLength(1);
    await expect(index.suggest('calendar', { types: ['draft' as UseCaseType] })).rejects.toThrow('types');
    await expect(index.suggest('calendar', { allowedSlugs: [42 as unknown as string] })).rejects.toThrow('allowedSlugs');
  });

  it('returns declared input metadata with each suggestion', async() => {
    // risk: data accuracy — the composer needs the declared fields to start a workflow.
    const workflow: UseCaseCatalogItem = { ...item('book-meeting', 'schedule a calendar meeting', 'workflow'), inputs: [{ name: 'attendee', label: 'Attendee', required: true }] };
    const index = build(new FixtureCatalog([workflow]));
    expect((await index.suggest('calendar meeting'))[0].inputs).toEqual([{ name: 'attendee', label: 'Attendee', required: true }]);
  });
});

describe('UseCaseSuggestionIndex lifecycle and races', () => {
  it('shares one catalog load between concurrent cold queries', async() => {
    // risk: performance — N concurrent first keystrokes must not trigger N full catalog loads.
    const source = new FixtureCatalog([item('calendar-skill', 'calendar meetings')]);
    const loader = vi.fn(async() => new TopicEmbedder());
    const index = build(source, { loader });
    const results = await Promise.all([index.suggest('calendar'), index.suggest('calendar'), index.warm(), index.suggest('meeting')]);
    expect(source.listCalls).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results[0].map(row => row.slug)).toEqual(['calendar-skill']);
  });

  it('a delete that commits during a slow initial load is not resurrected', async() => {
    // risk: data accuracy — a deleted/unpublished use case must never come back from a stale snapshot.
    const notifier = new LocalUseCaseChangeNotifier(quietLogger);
    const source = new FixtureCatalog([item('calendar-skill', 'calendar meetings'), item('calendar-old', 'calendar meetings')]);
    let release!: () => void;
    source.gate = new Promise(resolve => { release = resolve; });
    const index = build(source, { notifier });
    const warming = index.warm();
    await flush();
    source.rows = source.rows.filter(row => row.slug !== 'calendar-old');
    notifier.emit({ type: 'skill', slug: 'calendar-old', change: 'deleted' });
    release();
    await warming; await flush();
    expect((await index.suggest('calendar')).map(row => row.slug)).toEqual(['calendar-skill']);
  });

  it('an update that commits during a slow initial load wins over the stale snapshot', async() => {
    // risk: data accuracy — updated text must replace the old embedding, not be overwritten by it.
    const notifier = new LocalUseCaseChangeNotifier(quietLogger);
    const source = new FixtureCatalog([item('helper', 'calendar meetings')]);
    let release!: () => void;
    source.gate = new Promise(resolve => { release = resolve; });
    const index = build(source, { notifier });
    const warming = index.warm();
    await flush();
    source.rows = [item('helper', 'mail inbox')];
    notifier.emit({ type: 'skill', slug: 'helper', change: 'updated' });
    release();
    await warming; await flush();
    expect(await index.suggest('calendar')).toEqual([]);
    expect((await index.suggest('mail')).map(row => row.slug)).toEqual(['helper']);
  });

  it('applies publish, update and delete events in order', async() => {
    // risk: data accuracy — out-of-order async event handling must not leave a stale row.
    const notifier = new LocalUseCaseChangeNotifier(quietLogger);
    const source = new FixtureCatalog([item('mail-skill', 'mail inbox')]);
    const index = build(source, { notifier });
    await index.warm();
    source.rows.push(item('calendar-report', 'calendar planning'));
    notifier.emit({ type: 'skill', slug: 'calendar-report', change: 'published' });
    source.rows = source.rows.filter(row => row.slug !== 'calendar-report');
    notifier.emit({ type: 'skill', slug: 'calendar-report', change: 'deleted' });
    await flush();
    expect(await index.suggest('calendar')).toEqual([]);
  });

  it('a catalog failure keeps the index cold and retries instead of locking in empty or keyword mode', async() => {
    // risk: availability — one Postgres hiccup at startup must not disable suggestions until restart.
    const clock = { t: 0 };
    const source = new FixtureCatalog([item('calendar-skill', 'calendar meetings')]);
    source.failList = 1;
    const index = build(source, { clock, tuning: { catalogRetryMinMs: 1000 } });
    expect(await index.suggest('calendar')).toEqual([]);
    expect(index.mode).toBe('cold');
    expect(await index.suggest('calendar')).toEqual([]);
    expect(source.listCalls).toBe(1);
    clock.t = 1001;
    const rows = await index.suggest('calendar');
    expect(rows.map(row => [row.slug, row.reason])).toEqual([['calendar-skill', 'semantic match']]);
    expect(index.mode).toBe('semantic');
  });

  it('reconciles a definition edited without any change event', async() => {
    // risk: data accuracy — UI/tool CRUD paths that never emit events must still reach suggestions.
    const clock = { t: 0 };
    const source = new FingerprintedCatalog([item('helper', 'calendar meetings'), item('retired', 'calendar meetings')]);
    const index = build(source, { clock, tuning: { reconcileEveryMs: 1000 } });
    expect(await index.suggest('calendar')).toHaveLength(2);
    source.rows = [item('helper', 'mail inbox')];
    clock.t = 1001;
    await index.suggest('calendar'); await flush();
    expect(await index.suggest('calendar')).toEqual([]);
    expect((await index.suggest('mail')).map(row => row.slug)).toEqual(['helper']);
  });

  it('a throwing listener cannot make a committed write report failure', () => {
    // risk: irreversible side effects — callers emit after commit; an emit error must not surface as a failed install.
    const notifier = new LocalUseCaseChangeNotifier(quietLogger);
    const later = vi.fn();
    notifier.subscribe(() => { throw new Error('index down'); });
    notifier.subscribe(later);
    expect(() => notifier.emit({ type: 'skill', slug: 'x', change: 'installed' })).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });
});
