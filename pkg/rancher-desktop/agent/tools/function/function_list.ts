import { BaseTool, ToolResponse } from '../base';
import { RUNTIME_URLS } from './constants';

export class FunctionListWorker extends BaseTool {
  name = 'function_list';
  description = 'List all available custom functions stored in Postgres.';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const rows: string[] = [];
    let loaded = 0;
    const { FunctionDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');
    for (const fn of await FunctionDefinitionModel.list()) {
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

    if (loaded === 0) return { successBoolean: true, responseString: 'No functions found in Postgres.' };
    const header = `Found ${ loaded } function${ loaded !== 1 ? 's' : '' } in Postgres:\n`;
    return {
      successBoolean: true,
      responseString: header + rows.join('\n\n'),
    };
  }
}
