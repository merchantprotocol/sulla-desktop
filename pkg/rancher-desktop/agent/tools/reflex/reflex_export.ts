import fs from 'fs/promises';
import path from 'path';

import { ReflexModel } from '../../database/models/ReflexModel';
import { BaseTool, ToolResponse } from '../base';

export class ReflexExportWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const rows = await ReflexModel.listExamples({ limit: 10_000 });
    const seed = {
      version:  1,
      exported: new Date().toISOString(),
      examples: rows
        .sort((a, b) => a.tool_name.localeCompare(b.tool_name) || a.utterance.localeCompare(b.utterance))
        .map(r => ({ utterance: r.utterance, tool: r.tool_name, params: r.params, positive: r.positive })),
    };
    const json = JSON.stringify(seed, null, 2);
    if (typeof input.path === 'string' && input.path.trim()) {
      const target = input.path.trim();
      if (!path.isAbsolute(target)) return { successBoolean: false, responseString: 'path must be absolute' };
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, json, 'utf8');
      return { successBoolean: true, responseString: `Exported ${ seed.examples.length } reflex examples to ${ target }` };
    }
    return { successBoolean: true, responseString: json };
  }
}
