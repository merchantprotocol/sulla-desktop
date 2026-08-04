import { KnowledgeGraphModel, type SpreadActivationRecord } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';

const DEFAULT_LIMIT = 12;

function cleanTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return [];
  return Array.from(new Set(terms.map(String).map(t => t.trim()).filter(Boolean))).slice(0, 8);
}

function cleanLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(24, Math.floor(parsed)));
}

export function formatEpisodicContext(rows: SpreadActivationRecord[]): string {
  if (rows.length === 0) return '';

  return rows.map((row) => {
    const type = (row.node_type || 'entity').trim();
    const title = (row.title || row.id).trim();
    const summary = (row.summary || '').trim();
    const activation = Number(row.activation ?? 0).toFixed(3);
    const hop = Number(row.hop ?? 0);
    const body = summary ? `${ title } — ${ summary }` : title;

    return `[${ type }] ${ body } (id: ${ row.id }, activation: ${ activation }, hop: ${ hop })`;
  }).join('\n');
}

export class EpisodicRecallWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const terms = cleanTerms(input.terms);
    const limit = cleanLimit(input.limit);

    if (terms.length === 0) {
      return {
        successBoolean: false,
        responseString: 'Provide at least one non-empty term to recall from episodic memory.',
      };
    }

    try {
      const rows = await KnowledgeGraphModel.recallByTerms(terms, {
        maxHops:            2,
        decay:              0.5,
        limit,
        statementTimeoutMs: 3_000,
      });
      const context = formatEpisodicContext(rows);

      return {
        successBoolean: true,
        responseString: context
          ? `<episodic_context>\n${ context }\n</episodic_context>`
          : '<episodic_context />',
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to recall episodic context: ${ err?.message || String(err) }`,
      };
    }
  }
}
