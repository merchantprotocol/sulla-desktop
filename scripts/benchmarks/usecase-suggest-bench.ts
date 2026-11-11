// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { UseCaseSuggestionIndex, LocalUseCaseChangeNotifier, type UseCaseCatalogItem } from '../../pkg/sulla-desktop/agent/useCases/UseCaseSuggestionIndex';
import { potionSuggestionEmbedderLoader } from '../../pkg/sulla-desktop/agent/useCases/UseCaseSuggestionCompositionRoot';

class SyntheticCatalog {
  readonly rows: UseCaseCatalogItem[] = Array.from({ length: 2000 }, (_, i) => ({ type: ['skill','agent','workflow','function','recipe'][i % 5] as UseCaseCatalogItem['type'], slug: `use-case-${i}`, title: `Use case ${i} ${['calendar','mail','database','research','deploy'][i % 5]}`, description: `Helps users ${['schedule meetings','manage inbox','query records','research topics','deploy services'][i % 5]} with examples and practical guidance.`, tags: ['productivity', 'automation'], triggers: ['help me', 'show how'] }));
  async listPublished(): Promise<UseCaseCatalogItem[]> { return this.rows; }
  async findPublished(): Promise<null> { return null; }
}
class DeterministicEmbedder {
  readonly dim = 64;
  embed(text: string): Float32Array { const v = new Float32Array(64); for (const token of text.toLowerCase().split(/\W+/)) { let h = 0; for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) | 0; v[Math.abs(h) % 64] += 1; } let n = Math.sqrt(v.reduce((s, x) => s + x*x, 0)); if (n) for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
}
const samples: Record<string, number[]> = { embed: [], rank: [], total: [] };
class BenchmarkLogger {
  fallbackDiagnostic?: string;
  info(line: string): void {
    const m = line.match(/embedMs=([\d.]+) rankMs=([\d.]+) totalMs=([\d.]+)/);
    if (m) { samples.embed.push(+m[1]); samples.rank.push(+m[2]); samples.total.push(+m[3]); }
    if (line.includes('embedder unavailable')) {
      // Keep diagnostics useful without printing arbitrary exception text, paths, or user data.
      const code = line.match(/\b(ENOENT|EACCES|EINVAL|ERR_[A-Z0-9_]+)\b/)?.[1];
      this.fallbackDiagnostic = line.includes('Potion retrieval model directory unavailable')
        ? 'model directory unresolved'
        : code ? `model file access failed (${ code })`
          : line.includes('bad magic') ? 'model binary format invalid (bad magic)'
            : line.includes('table shape mismatch') ? 'model binary shape invalid'
              : line.includes('SyntaxError') ? 'tokenizer JSON invalid'
                : 'model load/runtime error (details redacted)';
    }
  }
}
const logger = new BenchmarkLogger();
const percentile = (xs: number[], p: number): number => { const sorted = [...xs].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1, Math.ceil(p*sorted.length)-1)] ?? 0; };
const real = process.argv.includes('--real');
const catalog = new SyntheticCatalog();
const index = new UseCaseSuggestionIndex(real ? potionSuggestionEmbedderLoader : async () => new DeterministicEmbedder(), catalog, new LocalUseCaseChangeNotifier(), logger, () => performance.now());
await index.warm();
const queries = Array.from({ length: 500 }, (_, i) => [`find a skill for ${['calendar meeting','mail inbox','database records','research','deploy'][i % 5]}`, `help me ${['schedule a meeting','organize email','query my data','summarize research','ship a service'][i % 5]}`, `what can automate ${['calendar','mail','records','research','deployment'][i % 5]}?`][i % 3]);
for (const query of queries) {
  await index.suggest(query, { limit: 8 });
  if (real && index.mode !== 'semantic') break;
}
const actualMode = index.mode;
if (real && actualMode !== 'semantic') {
  console.error(JSON.stringify({ mode: actualMode, catalog: 'synthetic', model: 'potion-retrieval-32M', error: logger.fallbackDiagnostic ?? 'embedder did not load; no fallback diagnostic was recorded' }));
  process.exitCode = 1;
} else {
console.log(JSON.stringify({ mode: actualMode, catalog: 'synthetic', embedder: real ? 'potion-retrieval-32M' : 'deterministic', rows: index.rowCount, queries: queries.length, p50_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.5)])), p95_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.95)])), p99_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.99)])) }, null, 2));
// Threshold calibration aid: compare top raw scores for on-topic vs unrelated text (minScore 0 shows everything).
const unrelated = ['what is the capital of mongolia', 'my cat ate a sandwich', 'zebra quantum violin'];
const topScore = async(text: string): Promise<number> => (await index.suggest(text, { limit: 1, minScore: 0 }))[0]?.score ?? 0;
console.log(JSON.stringify({ mode: index.mode, thresholds: index.thresholds, related_top_scores: await Promise.all(queries.slice(0, 5).map(topScore)), unrelated_top_scores: await Promise.all(unrelated.map(topScore)) }, null, 2));
}
