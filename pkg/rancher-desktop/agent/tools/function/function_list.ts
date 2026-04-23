import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';
import { RUNTIME_URLS } from './constants';

export class FunctionListWorker extends BaseTool {
  name = 'function_list';
  description = 'List all available custom functions installed in ~/sulla/functions/.';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const { resolveSullaFunctionsDir } = await import('@pkg/agent/utils/sullaPaths');
    const functionsDir = resolveSullaFunctionsDir();

    if (!fs.existsSync(functionsDir)) {
      return { successBoolean: true, responseString: 'No functions directory found at ~/sulla/functions/ — no functions installed yet.' };
    }

    const entries = fs.readdirSync(functionsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    if (entries.length === 0) {
      return { successBoolean: true, responseString: 'No functions found in ~/sulla/functions/.' };
    }

    const rows: string[] = [];
    let loaded = 0;
    let errored = 0;

    for (const entry of entries) {
      const yamlPath = path.join(functionsDir, entry.name, 'function.yaml');
      if (!fs.existsSync(yamlPath)) continue;

      try {
        const parsed: any = yaml.parse(fs.readFileSync(yamlPath, 'utf-8')) || {};
        const spec = parsed.spec ?? {};
        const runtime: string = spec.runtime || 'unknown';
        const slug = typeof parsed.slug === 'string' ? parsed.slug : entry.name;
        const name = typeof parsed.name === 'string' ? parsed.name : slug;
        const description = typeof parsed.description === 'string' ? parsed.description.trim().split('\n')[0] : '';
        const inputs = Object.keys(spec.inputs || {});
        const outputs = Object.keys(spec.outputs || {});
        const runtimeUrl = RUNTIME_URLS[runtime] ?? 'unknown port';

        rows.push([
          `  slug:        ${ slug }`,
          `  name:        ${ name }`,
          `  runtime:     ${ runtime } (${ runtimeUrl })`,
          `  entrypoint:  ${ spec.entrypoint || 'unknown' }`,
          description ? `  description: ${ description }` : null,
          inputs.length ? `  inputs:      ${ inputs.join(', ') }` : null,
          outputs.length ? `  outputs:     ${ outputs.join(', ') }` : null,
        ].filter(Boolean).join('\n'));

        loaded++;
      } catch (err) {
        rows.push(`  ${ entry.name } — parse error: ${ (err as Error).message }`);
        errored++;
      }
    }

    const header = `Found ${ loaded } function${ loaded !== 1 ? 's' : '' }${ errored ? ` (${ errored } with parse errors)` : '' } in ~/sulla/functions/:\n`;
    return {
      successBoolean: true,
      responseString: header + rows.join('\n\n'),
    };
  }
}
