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

    const entries = (fs.existsSync(functionsDir) ? fs.readdirSync(functionsDir, { withFileTypes: true }) : [])
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    const rows: string[] = [];
    let loaded = 0;
    let errored = 0;
    const databaseSlugs = new Set<string>();

    try {
      const { FunctionDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');
      for (const fn of await FunctionDefinitionModel.list()) {
        databaseSlugs.add(fn.slug);
        const spec = fn.manifest.spec ?? {};
        const inputs = Object.keys(spec.inputs || {});
        const outputs = Object.keys(spec.outputs || {});
        rows.push([
          `  slug:        ${ fn.slug }`,
          `  name:        ${ fn.name }`,
          `  runtime:     ${ fn.runtime } (${ RUNTIME_URLS[fn.runtime] ?? 'unknown port' })`,
          `  entrypoint:  ${ spec.entrypoint || 'unknown' }`,
          fn.description ? `  description: ${ fn.description.trim().split('\n')[0] }` : null,
          inputs.length ? `  inputs:      ${ inputs.join(', ') }` : null,
          outputs.length ? `  outputs:     ${ outputs.join(', ') }` : null,
          '  source:      database',
        ].filter(Boolean).join('\n'));
        loaded++;
      }
    } catch (err) {
      console.warn('[function_list] Database functions unavailable; falling back to legacy folders:', err);
    }

    for (const entry of entries) {
      if (databaseSlugs.has(entry.name)) continue;
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

    if (loaded === 0 && errored === 0) return { successBoolean: true, responseString: 'No functions found in Postgres or the legacy ~/sulla/functions/ folder.' };
    const header = `Found ${ loaded } function${ loaded !== 1 ? 's' : '' }${ errored ? ` (${ errored } with parse errors)` : '' } (Postgres first, then legacy folders):\n`;
    return {
      successBoolean: true,
      responseString: header + rows.join('\n\n'),
    };
  }
}
