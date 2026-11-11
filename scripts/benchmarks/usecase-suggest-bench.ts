// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { UseCaseSuggestionIndex, LocalUseCaseChangeNotifier, potionSuggestionEmbedderLoader, type UseCaseCatalogItem } from '../../pkg/sulla-desktop/agent/useCases/UseCaseSuggestionIndex';
import { PostgresUseCaseCatalogSource } from '../../pkg/sulla-desktop/agent/useCases/PostgresUseCaseCatalogSource';
import { postgresClient } from '../../pkg/sulla-desktop/agent/database/PostgresClient';
import { getBuiltinSkillSpecs } from '../../pkg/sulla-desktop/agent/builtinSkills';

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
const logger = { info(line: string) { const m = line.match(/embedMs=([\d.]+) rankMs=([\d.]+) totalMs=([\d.]+)/); if (m) { samples.embed.push(+m[1]); samples.rank.push(+m[2]); samples.total.push(+m[3]); } } };
const percentile = (xs: number[], p: number): number => { const sorted = [...xs].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1, Math.ceil(p*sorted.length)-1)] ?? 0; };
const real = process.argv.includes('--real');
const liveDb = Boolean(process.env.SULLA_DATABASE_URL);
const catalog = liveDb ? new PostgresUseCaseCatalogSource(postgresClient, getBuiltinSkillSpecs().map(skill => skill.slug)) : new SyntheticCatalog();
const index = new UseCaseSuggestionIndex(real ? potionSuggestionEmbedderLoader : async () => new DeterministicEmbedder(), catalog, new LocalUseCaseChangeNotifier(), logger, () => performance.now());
await index.warm();
const queries = Array.from({ length: 500 }, (_, i) => [`find a skill for ${['calendar meeting','mail inbox','database records','research','deploy'][i % 5]}`, `help me ${['schedule a meeting','organize email','query my data','summarize research','ship a service'][i % 5]}`, `what can automate ${['calendar','mail','records','research','deployment'][i % 5]}?`][i % 3]);
for (const query of queries) await index.suggest(query, { limit: 8 });
console.log(JSON.stringify({ mode: `${liveDb ? 'postgres' : 'synthetic'}-${real ? 'potion-real' : 'deterministic'}`, rows: index.rowCount, queries: queries.length, p50_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.5)])), p95_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.95)])), p99_ms: Object.fromEntries(Object.entries(samples).map(([k,v])=>[k, percentile(v,.99)])) }, null, 2));
