import yaml from 'yaml';
import { FilesTool, writeUseCaseDraft } from '../files/common';
import { draftResponse } from '../useCaseDraft';
import type { ToolResponse } from '../base';

export class ImportWorkflowWorker extends FilesTool {
  name = 'import_workflow';
  description = 'Import an inline YAML workflow definition into Sulla Files as a draft. Only a published version can be executed.';
  schemaDef = {
    slug: { type: 'string' as const, description: 'The workflow slug / id.' },
    yaml: { type: 'string' as const, description: 'The complete workflow definition as YAML.' },
    status: { type: 'string' as const, optional: true, description: 'Retained in the draft manifest for compatibility; publication controls activation.' },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug = String(input.slug ?? '').trim();
    let definition: any;
    try { definition = yaml.parse(String(input.yaml ?? '')); }
    catch (err) { return { successBoolean: false, responseString: `Failed to parse workflow YAML: ${ (err as Error).message }` }; }
    if (!slug || !definition?.id || !definition?.name) return { successBoolean: false, responseString: 'Workflow YAML is missing required fields "id" and/or "name".' };
    if (definition.id !== slug) return { successBoolean: false, responseString: `slug must match workflow id (${ definition.id }).` };
    try {
      const files = { 'workflow.yaml': String(input.yaml) };
      const written = await writeUseCaseDraft(this, input, 'workflows', slug, files);
      return draftResponse('workflows', slug, files, written);
    } catch (error) { return { successBoolean: false, responseString: `Could not save workflow draft: ${ error instanceof Error ? error.message : String(error) }` }; }
  }
}
