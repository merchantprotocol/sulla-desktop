import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

export interface CustomAgentSummary {
  id:          string;
  name:        string;
  description: string;
  type:        string;
  templateId:  string;
  provider:    string;
  model:       string;
  path:        string;
}

export interface CustomAgentDefinition extends CustomAgentSummary {
  prompt: string;
}

export interface CustomAgentInput {
  name:      string;
  model:     string;
  prompt:    string;
  provider?: string;
}

const SAFE_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyAgentName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'custom-agent';
}

export class CustomAgentDefinitions {
  constructor(private readonly agentsDir: string) {}

  list(): CustomAgentSummary[] {
    if (!fs.existsSync(this.agentsDir)) return [];

    return fs.readdirSync(this.agentsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => this.readSummary(entry.name))
      .filter((agent): agent is CustomAgentSummary => agent !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): CustomAgentDefinition | null {
    const summary = this.readSummary(id);

    if (!summary) return null;

    const promptPath = path.join(summary.path, 'prompt.md');

    return {
      ...summary,
      prompt: fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : '',
    };
  }

  create(input: CustomAgentInput): CustomAgentDefinition {
    const name = this.requireText(input.name, 'Agent name');
    const model = this.requireText(input.model, 'Model');
    const baseSlug = slugifyAgentName(name);
    let id = baseSlug;
    let suffix = 2;

    fs.mkdirSync(this.agentsDir, { recursive: true });
    while (fs.existsSync(path.join(this.agentsDir, id))) {
      id = `${ baseSlug }-${ suffix++ }`;
    }

    const agentDir = this.agentDir(id);

    fs.mkdirSync(agentDir);
    try {
      const config = {
        id,
        name,
        description:        `Custom agent: ${ name }`,
        type:               'worker',
        provider:           input.provider?.trim() || 'claude-code',
        model,
        injectObservations: false,
        skills:             [],
        tools:              ['exec', 'file_search'],
      };

      fs.writeFileSync(path.join(agentDir, 'config.yaml'), YAML.stringify(config), 'utf-8');
      fs.writeFileSync(path.join(agentDir, 'prompt.md'), input.prompt ?? '', 'utf-8');
    } catch (err) {
      fs.rmSync(agentDir, { recursive: true, force: true });
      throw err;
    }

    return this.get(id)!;
  }

  update(id: string, input: CustomAgentInput): CustomAgentDefinition {
    const agentDir = this.agentDir(id);
    const configPath = path.join(agentDir, 'config.yaml');

    if (!fs.existsSync(configPath)) throw new Error(`Agent not found: ${ id }`);

    const doc = YAML.parseDocument(fs.readFileSync(configPath, 'utf-8'));

    if (doc.errors.length > 0) throw doc.errors[0];

    doc.set('name', this.requireText(input.name, 'Agent name'));
    doc.set('model', this.requireText(input.model, 'Model'));
    fs.writeFileSync(configPath, doc.toString(), 'utf-8');
    fs.writeFileSync(path.join(agentDir, 'prompt.md'), input.prompt ?? '', 'utf-8');

    return this.get(id)!;
  }

  delete(id: string): boolean {
    const agentDir = this.agentDir(id);

    if (!fs.existsSync(agentDir)) return false;
    fs.rmSync(agentDir, { recursive: true });
    return true;
  }

  private readSummary(id: string): CustomAgentSummary | null {
    const agentDir = this.agentDir(id);
    const configPath = path.join(agentDir, 'config.yaml');

    if (!fs.existsSync(configPath)) return null;

    try {
      const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8')) || {};

      return {
        id,
        name:        parsed.name || id,
        description: parsed.description || '',
        type:        parsed.type || 'worker',
        templateId:  parsed.templateId || 'glass-core',
        provider:    typeof parsed.provider === 'string' ? parsed.provider : '',
        model:       typeof parsed.model === 'string' ? parsed.model : '',
        path:        agentDir,
      };
    } catch (err) {
      console.warn(`[CustomAgentDefinitions] Failed to parse ${ configPath }:`, err);
      return null;
    }
  }

  private agentDir(id: string): string {
    if (!SAFE_AGENT_ID.test(id)) throw new Error('Invalid agent ID');
    return path.join(this.agentsDir, id);
  }

  private requireText(value: string, label: string): string {
    const trimmed = value?.trim();

    if (!trimmed) throw new Error(`${ label } is required`);
    return trimmed;
  }
}
