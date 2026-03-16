import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveSullaAgentsDir } from '@pkg/agent/utils/sullaPaths';

export class ListAgentsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const agentsDir = resolveSullaAgentsDir();

    if (!fs.existsSync(agentsDir)) {
      return {
        successBoolean: false,
        responseString: `Agents directory not found: ${ agentsDir }`,
      };
    }

    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    const agents: { id: string; name: string; description: string; type: string; skills: string[]; tools: string[] }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const configPath = path.join(agentsDir, entry.name, 'config.yaml');
      if (!fs.existsSync(configPath)) continue;

      try {
        const yaml = await import('yaml');
        const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));

        agents.push({
          id:          entry.name,
          name:        parsed.name || entry.name,
          description: parsed.description || '(no description)',
          type:        parsed.type || 'worker',
          skills:      parsed.skills || [],
          tools:       parsed.tools || [],
        });
      } catch {
        agents.push({
          id:          entry.name,
          name:        entry.name,
          description: '(config unreadable)',
          type:        'unknown',
          skills:      [],
          tools:       [],
        });
      }
    }

    if (agents.length === 0) {
      return {
        successBoolean: true,
        responseString: `No agent configurations found in ${ agentsDir }. Create a folder with a config.yaml to define an agent.`,
      };
    }

    const formatted = agents.map(a =>
      `- **${ a.id }** (${ a.name }): ${ a.description }${ a.skills.length ? ` | skills: ${ a.skills.join(', ') }` : '' }${ a.tools.length ? ` | tools: ${ a.tools.join(', ') }` : '' }`,
    ).join('\n');

    return {
      successBoolean: true,
      responseString: `Found ${ agents.length } agent configuration(s):\n\n${ formatted }`,
    };
  }
}
