import { describe, expect, it } from 'vitest';
import { LocalUseCaseChangeNotifier, UseCaseSuggestionIndex, type SuggestionEmbedder } from '../agent/useCases/UseCaseSuggestionIndex';
import { UseCaseSuggestionIpcRegistrar } from './useCaseSuggestionIpc';
import type { SuggestionOptions } from '../agent/useCases/UseCaseSuggestionIndex';

describe('use-case suggestion IPC registrations', () => {
  it('dispatches both registered channels through the same live index service', async() => {
    // risk: integration omission — renderer/agent IPC must reach the watcher-owned ranking service
    const notifier = new LocalUseCaseChangeNotifier({ info: () => undefined });
    const embedder: SuggestionEmbedder = { dim: 2, embed: text => text.includes('deploy') ? new Float32Array([1, 0]) : new Float32Array([0, 1]) };
    const index = new UseCaseSuggestionIndex(async() => embedder, {
      listPublished: async() => [
        { type: 'skill', slug: 'deploy-skill', title: 'Deploy skill', description: 'Deploy safely' },
        { type: 'agent', slug: 'release-agent', title: 'Release agent', description: 'Deploy releases' },
        { type: 'function', slug: 'deploy-function', title: 'Deploy function', description: 'Deploy function' },
      ],
      findPublished: async(type, slug) => (await (async() => [
        { type: 'skill' as const, slug: 'deploy-skill', title: 'Deploy skill', description: 'Deploy safely' },
        { type: 'agent' as const, slug: 'release-agent', title: 'Release agent', description: 'Deploy releases' },
        { type: 'function' as const, slug: 'deploy-function', title: 'Deploy function', description: 'Deploy function' },
      ])()).find(item => item.type === type && item.slug === slug) ?? null,
    }, notifier, { info: () => undefined }, () => 10_000, { semanticThreshold: 0, keywordThreshold: 0 });
    await index.warm();
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    new UseCaseSuggestionIpcRegistrar(
      (channel, handler) => handlers.set(channel, handler),
      (channel, handler) => handlers.set(channel, handler),
      { suggest: (text, options) => index.suggest(text, options as SuggestionOptions) },
      { suggest: (text, options) => index.suggest(text, options) },
    ).register();

    const composer = await handlers.get('use-case-suggest:query')!({}, 'deploy');
    const recall = await handlers.get('use-case-recall:query')!({}, 'deploy', { types: ['agent'], allowedSlugs: ['release-agent'] });

    expect(composer.items.map(item => item.slug)).toContain('deploy-skill');
    expect(composer.items.some(item => item.type === 'function')).toBe(false);
    expect(recall.items.map(item => item.slug)).toEqual(['release-agent']);
    index.dispose();
  });
});
