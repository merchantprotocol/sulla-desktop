import { KnowledgeGraphModel, type EpisodeNodeInput, type WriteEpisodeInput } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * EpisodicWriteEpisode (#518) — persist one completed episode to the knowledge
 * graph. The Scribe agent encodes what happened, then calls this ONCE. All
 * writes are atomic (single transaction) with resolve-and-reuse dedup, alias
 * capture, linking (every new node gets ≥1 edge), and Hebbian reinforcement of
 * co-occurring pairs. See KnowledgeGraphModel.writeEpisode for the contract.
 */
export class EpisodicWriteEpisodeWorker extends BaseTool {
  name = '';
  description = '';

  private normNode(raw: any): EpisodeNodeInput | null {
    if (!raw) return null;
    // Accept either a string ("just a title") or a full object.
    if (typeof raw === 'string') {
      const title = raw.trim();
      return title ? { title } : null;
    }
    const title = String(raw.title ?? '').trim();
    if (!title) return null;
    return {
      title,
      summary:   raw.summary != null ? String(raw.summary) : undefined,
      detail:    raw.detail != null ? String(raw.detail) : undefined,
      aliases:   Array.isArray(raw.aliases) ? raw.aliases.map(String).filter(Boolean) : undefined,
      node_type: raw.node_type != null ? String(raw.node_type) : undefined,
    };
  }

  private normList(raw: any): EpisodeNodeInput[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(r => this.normNode(r)).filter((n): n is EpisodeNodeInput => n != null);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const event = this.normNode(input.event);
    if (!event) {
      return { successBoolean: false, responseString: 'episodic_write_episode requires an "event" with a non-empty title ("what happened").' };
    }

    // Reinforce pairs: accept [[a,b],...] or [{a,b}/{from,to}/{src,dst}].
    const reinforcePairs: [string, string][] = [];
    if (Array.isArray(input.reinforcePairs)) {
      for (const p of input.reinforcePairs) {
        if (Array.isArray(p) && p[0] && p[1]) reinforcePairs.push([String(p[0]), String(p[1])]);
        else if (p && typeof p === 'object') {
          const a = p.a ?? p.from ?? p.src;
          const b = p.b ?? p.to ?? p.dst;
          if (a && b) reinforcePairs.push([String(a), String(b)]);
        }
      }
    }

    const payload: WriteEpisodeInput = {
      source:         input.source != null ? String(input.source) : undefined,
      project:        this.normNode(input.project),
      event,
      lessons:        this.normList(input.lessons),
      blockers:       this.normList(input.blockers),
      entities:       this.normList(input.entities),
      reinforcePairs,
    };

    try {
      const r = await KnowledgeGraphModel.writeEpisode(payload);
      return {
        successBoolean: true,
        responseString:
          `Episode written: ${ r.episodeId }\n` +
          `nodes: ${ r.createdNodes } created, ${ r.reusedNodes } reused\n` +
          `edges: ${ r.linksCreated } created, ${ r.reinforced } reinforced\n` +
          `nodeIds: ${ r.nodeIds.join(', ') }`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to write episode: ${ err?.message ?? String(err) }` };
    }
  }
}
