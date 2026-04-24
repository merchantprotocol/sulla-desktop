import * as fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { artifactDir, artifactManifestPath, isArtifactKind, KIND_LAYOUTS, ArtifactKind } from './types';

export class MarketplaceValidateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Not installed locally: ${ dir }` };
    }

    const manifestPath = artifactManifestPath(kind, slug);
    if (!fs.existsSync(manifestPath)) {
      return { successBoolean: false, responseString: `Manifest missing: expected ${ manifestPath }` };
    }

    const issues: string[] = [];
    let manifestRaw = '';
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    } catch (err) {
      return { successBoolean: false, responseString: `Could not read manifest: ${ (err as Error).message }` };
    }

    const result = await validateByKind(kind, slug, dir, manifestRaw);
    issues.push(...result);

    // Filter out advisory notes (they aren't failures, just guidance).
    const errors = issues.filter(i => !i.startsWith('Note:'));
    const notes = issues.filter(i => i.startsWith('Note:'));

    if (errors.length === 0) {
      const noteSection = notes.length > 0 ? `\n${ notes.map(n => `  ℹ ${ n }`).join('\n') }` : '';
      return { successBoolean: true, responseString: `✓ ${ kind }/${ slug } passes validation.${ noteSection }` };
    }

    const noteSection = notes.length > 0 ? `\n${ notes.map(n => `  ℹ ${ n }`).join('\n') }` : '';
    return {
      successBoolean: false,
      responseString: `${ kind }/${ slug } has ${ errors.length } issue(s):\n${ errors.map(i => `  ✗ ${ i }`).join('\n') }${ noteSection }`,
    };
  }
}

async function validateByKind(kind: ArtifactKind, slug: string, dir: string, manifestRaw: string): Promise<string[]> {
  const issues: string[] = [];

  if (kind === 'skill') {
    if (!manifestRaw.trim().startsWith('#')) issues.push('SKILL.md should start with a level-1 heading (the skill name).');
    if (manifestRaw.trim().length < 50) issues.push('SKILL.md is suspiciously short — needs trigger conditions + instructions.');
    return issues;
  }

  if (kind === 'workflow') {
    // Lightweight shape check; for full validation run `sulla meta/validate_sulla_workflow`.
    try {
      const yaml = await import('yaml');
      const parsed: any = yaml.parse(manifestRaw);
      if (!parsed?.id)    issues.push('routine.yaml: missing required key "id"');
      if (!parsed?.name)  issues.push('routine.yaml: missing required key "name"');
      if (!Array.isArray(parsed?.nodes) || parsed.nodes.length === 0) issues.push('routine.yaml: "nodes" must be a non-empty array');
      if (!Array.isArray(parsed?.edges)) issues.push('routine.yaml: "edges" must be an array');
      const triggers = (parsed?.nodes || []).filter((n: any) => n?.data?.category === 'trigger');
      if (triggers.length === 0) issues.push('routine.yaml: at least one trigger node is required');
      issues.push('Note: for full schema/reachability checks, run `sulla meta/validate_sulla_workflow` against this routine.yaml.');
    } catch (err) {
      issues.push(`routine.yaml parse error: ${ (err as Error).message }`);
    }
    return issues;
  }

  if (kind === 'function') {
    let parsed: any;
    try {
      const yaml = await import('yaml');
      parsed = yaml.parse(manifestRaw);
    } catch (err) {
      issues.push(`function.yaml parse error: ${ (err as Error).message }`);
      return issues;
    }
    const required = ['apiVersion', 'kind', 'id', 'slug', 'spec'];
    for (const k of required) if (!parsed?.[k]) issues.push(`function.yaml: missing required key "${ k }"`);
    if (parsed?.kind && parsed.kind !== 'Function') issues.push(`function.yaml: kind must be "Function", got "${ parsed.kind }"`);
    if (parsed?.slug && parsed.slug !== slug) issues.push(`function.yaml: slug "${ parsed.slug }" must match directory name "${ slug }"`);
    const runtime = parsed?.spec?.runtime;
    if (!['python', 'node', 'shell', 'agent'].includes(runtime)) issues.push(`function.yaml: spec.runtime must be one of python|node|shell|agent (got "${ runtime }")`);
    const entrypoint = parsed?.spec?.entrypoint;
    if (!entrypoint) issues.push(`function.yaml: spec.entrypoint is required`);
    else {
      const file = entrypoint.split('::')[0];
      const filePath = `${ dir }/${ file }`;
      if (!fs.existsSync(filePath)) issues.push(`function.yaml: entrypoint file ${ file } does not exist on disk`);
    }
    return issues;
  }

  if (kind === 'agent') {
    let parsed: any;
    try {
      const yaml = await import('yaml');
      parsed = yaml.parse(manifestRaw);
    } catch (err) {
      issues.push(`config.yaml parse error: ${ (err as Error).message }`);
      return issues;
    }
    if (!parsed?.id) issues.push(`agent config.yaml: missing required key "id"`);
    if (parsed?.id && parsed.id !== slug) issues.push(`agent config.yaml: id "${ parsed.id }" must match directory name "${ slug }"`);
    if (!parsed?.name) issues.push(`agent config.yaml: missing required key "name"`);
    return issues;
  }

  if (kind === 'recipe') {
    let parsed: any;
    try {
      const yaml = await import('yaml');
      parsed = yaml.parse(manifestRaw);
    } catch (err) {
      issues.push(`manifest.yaml parse error: ${ (err as Error).message }`);
      return issues;
    }
    if (!parsed?.slug) issues.push(`recipe manifest.yaml: missing "slug"`);
    if (!parsed?.version) issues.push(`recipe manifest.yaml: missing "version"`);
    const compose = `${ dir }/docker-compose.yml`;
    if (!fs.existsSync(compose)) issues.push(`recipe: docker-compose.yml is required at ${ compose }`);
    return issues;
  }

  void KIND_LAYOUTS; // (silences "unused import" warnings if kinds change)
  return issues;
}
