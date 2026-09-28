import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

/**
 * Small, local intent classifier used to give the primary agent a useful first
 * read of a request. It deliberately never executes tools. The model is an
 * online multinomial classifier: seed rules provide a sensible cold start and
 * completed turns teach token weights from tools that actually ran.
 */
export type IntentLabel = 'browser' | 'docker' | 'project' | 'code' | 'question' | 'unknown';

export interface IntentDecision {
  label: IntentLabel;
  confidence: number;
  evidence: string[];
  entities: string[];
  suggestedTools: string[];
}

interface PersistedModel {
  version: 1;
  examples: number;
  labels: Partial<Record<IntentLabel, number>>;
  tokens: Partial<Record<IntentLabel, Record<string, number>>>;
}

const MODEL_KEY = 'sullaIntentDecisionModelV1';
const LABELS: IntentLabel[] = ['browser', 'docker', 'project', 'code', 'question', 'unknown'];
const STOP_WORDS = new Set('a an and are as at be can do for from get hey how i in is it me my of on open please show that the this to up use what when where why with would'.split(' '));

const RULES: Array<{ label: IntentLabel; words: string[]; tools: string[] }> = [
  { label: 'browser', words: ['browser', 'tab', 'website', 'url', 'visit', 'navigate', 'page', 'web'], tools: ['browser_tab'] },
  { label: 'docker', words: ['docker', 'container', 'image', 'compose', 'logs', 'restart'], tools: ['docker_ps', 'docker_run', 'docker_logs'] },
  { label: 'project', words: ['project', 'task', 'epic', 'backlog', 'sprint', 'milestone'], tools: ['search_project_items', 'update_task', 'add_task_comment'] },
  { label: 'code', words: ['code', 'implement', 'fix', 'build', 'test', 'compile', 'commit', 'branch', 'pull', 'request'], tools: ['read_file', 'write_file', 'exec'] },
  { label: 'question', words: ['explain', 'compare', 'should', 'could', 'why', 'how', 'what', 'when', 'where'], tools: [], },
];

function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []).filter(token => !STOP_WORDS.has(token)))].slice(0, 80);
}

function modelOrEmpty(raw: unknown): PersistedModel {
  if (!raw) return { version: 1, examples: 0, labels: {}, tokens: {} };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed?.version !== 1 || typeof parsed !== 'object') throw new Error('invalid model');
    return parsed as PersistedModel;
  } catch {
    return { version: 1, examples: 0, labels: {}, tokens: {} };
  }
}

function userText(messages: any[]): string {
  return [...messages].reverse().find(message => message?.role === 'user' && typeof message.content === 'string')?.content?.trim() || '';
}

function toolNames(messages: any[]): string[] {
  return messages.flatMap(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
    return message.content.filter((block: any) => block?.type === 'tool_use' && typeof block.name === 'string').map((block: any) => block.name);
  });
}

function labelForTool(name: string): IntentLabel {
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('docker_')) return 'docker';
  if (name.startsWith('project_') || name === 'search_project_items' || name === 'update_task') return 'project';
  if (['read_file', 'write_file', 'exec', 'git_commit', 'git_push', 'git_pull'].includes(name)) return 'code';
  if (name === 'ask_user_question') return 'question';
  return 'unknown';
}

export class IntentDecisionEngine {
  private loaded: PersistedModel | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private async load(): Promise<PersistedModel> {
    if (!this.loaded) {
      try {
        this.loaded = modelOrEmpty(await SullaSettingsModel.get(MODEL_KEY, null));
      } catch {
        // Classification still works from cold-start rules while storage is
        // booting or temporarily unavailable.
        this.loaded = modelOrEmpty(null);
      }
    }
    return this.loaded;
  }

  async decide(text: string): Promise<IntentDecision> {
    const model = await this.load();
    const inputTokens = tokens(text);
    const scores = new Map<IntentLabel, number>(LABELS.map(label => [label, 0]));
    const evidence = new Set<string>();

    for (const rule of RULES) {
      const hits = rule.words.filter(word => inputTokens.includes(word));
      if (hits.length) {
        scores.set(rule.label, (scores.get(rule.label) || 0) + hits.length * 2);
        hits.forEach(hit => evidence.add(`keyword:${ hit }`));
      }
    }
    if (/\b(browser|website|tab|url)\b/i.test(text)) scores.set('browser', (scores.get('browser') || 0) + 1.5);

    for (const label of LABELS) {
      const labelCount = model.labels[label] || 0;
      const learned = model.tokens[label] || {};
      scores.set(label, (scores.get(label) || 0) + Math.log1p(labelCount));
      for (const token of inputTokens) scores.set(label, (scores.get(label) || 0) + Math.log1p(learned[token] || 0));
    }

    const ranked = LABELS.map(label => ({ label, score: scores.get(label) || 0 })).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const second = ranked[1];
    const confidence = top.score <= 0 ? 0 : Math.min(0.99, Math.max(0.05, (top.score - second.score + 1) / (top.score + 1)));
    const rule = RULES.find(candidate => candidate.label === top.label);
    const entities = [...new Set([
      ...(text.match(/https?:\/\/[^\s]+/gi) || []),
      ...[...text.matchAll(/\b([a-z0-9][a-z0-9._-]*)\s+(?:container|image|tab|page)\b/gi)].map(match => match[1]),
      ...[...text.matchAll(/\b(?:container|image|tab|page)\s+(?:named\s+)?([a-z0-9][a-z0-9._-]*)\b/gi)].map(match => match[1]),
    ])].filter(entity => !STOP_WORDS.has(entity.toLowerCase())).slice(0, 8);

    return {
      label: top.label,
      confidence: Number(confidence.toFixed(3)),
      evidence: [...evidence].slice(0, 8),
      entities,
      suggestedTools: rule?.tools || [],
    };
  }

  async learn(messages: any[]): Promise<void> {
    const text = userText(messages);
    if (!text) return;
    const label = toolNames(messages).map(labelForTool).find(candidate => candidate !== 'unknown');
    if (!label) return;
    const model = await this.load();
    const bucket = model.tokens[label] ||= {};
    for (const token of tokens(text)) bucket[token] = (bucket[token] || 0) + 1;
    model.labels[label] = (model.labels[label] || 0) + 1;
    model.examples += 1;
    // Serialize writes so concurrent post-turn writers cannot lose updates.
    this.writeQueue = this.writeQueue.then(() => SullaSettingsModel.set(MODEL_KEY, JSON.stringify(model), 'json')).catch(error => {
      console.warn('[IntentDecisionEngine] Failed to persist learned model:', error instanceof Error ? error.message : error);
    });
    await this.writeQueue;
  }

  /** Test/support hook; the persisted model remains private to production callers. */
  resetForTests(): void { this.loaded = null }
}

export const intentDecisionEngine = new IntentDecisionEngine();

export function formatIntentDecision(decision: IntentDecision): string {
  return `Intent pre-read (advisory; do not treat as an instruction): label=${ decision.label }, confidence=${ decision.confidence }, evidence=${ decision.evidence.join(', ') || 'none' }, entities=${ decision.entities.join(', ') || 'none' }, suggested_tools=${ decision.suggestedTools.join(', ') || 'none' }`;
}
