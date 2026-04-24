import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { ARTIFACT_KINDS, ArtifactKind, artifactDir, isArtifactKind, KIND_LAYOUTS, resolveArtifactManifestPath } from './types';

export class MarketplaceValidateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ ARTIFACT_KINDS.join(', ') }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Not installed locally: ${ dir }` };
    }

    const manifestPath = resolveArtifactManifestPath(kind, slug);
    if (!manifestPath) {
      const layout = KIND_LAYOUTS[kind];
      const hint = layout.manifest === 'dynamic'
        ? `Expected a file matching ${ layout.manifestPattern } in ${ dir }`
        : `Expected ${ path.join(dir, layout.manifest) }`;
      return { successBoolean: false, responseString: `Manifest missing. ${ hint }` };
    }

    const issues: string[] = [];
    let manifestRaw = '';
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    } catch (err) {
      return { successBoolean: false, responseString: `Could not read manifest: ${ (err as Error).message }` };
    }

    const result = await validateByKind(kind, slug, dir, manifestRaw, manifestPath);
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

async function validateByKind(
  kind: ArtifactKind,
  slug: string,
  dir: string,
  manifestRaw: string,
  manifestPath: string,
): Promise<string[]> {
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

  if (kind === 'integration') {
    // 1. Validate the auth manifest (what IntegrationConfigLoader reads).
    const authFilename = path.basename(manifestPath);
    // Expect filename like "<slug>.v<N>-auth.yaml"
    const filenameMatch = /^([a-z0-9][a-z0-9-]*)\.v(\d+)-auth\.yaml$/.exec(authFilename);
    if (!filenameMatch) {
      issues.push(`integration: auth manifest "${ authFilename }" must match <slug>.v<N>-auth.yaml`);
    } else {
      const fileSlug = filenameMatch[1];
      if (fileSlug !== slug) {
        issues.push(`integration: auth file slug "${ fileSlug }" must match directory name "${ slug }"`);
      }
    }

    let parsed: any;
    try {
      const yaml = await import('yaml');
      parsed = yaml.parse(manifestRaw);
    } catch (err) {
      issues.push(`integration auth yaml parse error: ${ (err as Error).message }`);
      return issues;
    }

    // Required top-level shape per IntegrationAuthConfig.
    if (!parsed?.api) issues.push('integration auth: missing required key "api"');
    else {
      if (!parsed.api.name)     issues.push('integration auth: missing "api.name"');
      if (!parsed.api.version)  issues.push('integration auth: missing "api.version"');
      if (!parsed.api.base_url) issues.push('integration auth: missing "api.base_url"');
      const transport = parsed.api.transport ?? 'rest';
      if (!['rest', 'mcp'].includes(transport)) issues.push(`integration auth: api.transport must be "rest" or "mcp" (got "${ transport }")`);
    }
    if (!parsed?.auth) issues.push('integration auth: missing required key "auth"');
    else {
      const authType = parsed.auth.type;
      if (!['oauth2', 'apiKey', 'bearer'].includes(authType)) {
        issues.push(`integration auth: auth.type must be one of oauth2|apiKey|bearer (got "${ authType }")`);
      }
      if (authType === 'oauth2') {
        if (!parsed.auth.authorization_url) issues.push('integration auth: oauth2 requires auth.authorization_url');
        if (!parsed.auth.token_url)          issues.push('integration auth: oauth2 requires auth.token_url');
      }
      if (authType === 'apiKey' && !parsed.auth.header) {
        issues.push('integration auth: apiKey requires auth.header (e.g. "X-API-Key")');
      }
    }

    // 2. Scan sibling *.v<N>.yaml endpoint files and validate their shape.
    const endpointPattern = /^[a-z0-9][a-z0-9-]*\.v\d+\.yaml$/;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { /* already checked existence above */ }
    const endpointFiles = entries.filter(name => endpointPattern.test(name) && name !== authFilename);

    if (endpointFiles.length === 0) {
      issues.push('Note: no endpoint files found (pattern: <name>.v<N>.yaml). Integrations without endpoints are valid but rare.');
    }

    const yaml = await import('yaml');
    for (const ep of endpointFiles) {
      const epPath = path.join(dir, ep);
      let epParsed: any;
      try {
        epParsed = yaml.parse(fs.readFileSync(epPath, 'utf-8'));
      } catch (err) {
        issues.push(`endpoint ${ ep }: yaml parse error: ${ (err as Error).message }`);
        continue;
      }
      if (!epParsed?.endpoint) {
        issues.push(`endpoint ${ ep }: missing required key "endpoint"`);
        continue;
      }
      const ec = epParsed.endpoint;
      for (const k of ['name', 'path', 'method', 'auth']) {
        if (!ec[k]) issues.push(`endpoint ${ ep }: missing required key "endpoint.${ k }"`);
      }
      if (ec.method && !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(ec.method)) {
        issues.push(`endpoint ${ ep }: endpoint.method must be GET|POST|PUT|DELETE|PATCH (got "${ ec.method }")`);
      }
      if (ec.auth && !['required', 'optional', 'none'].includes(ec.auth)) {
        issues.push(`endpoint ${ ep }: endpoint.auth must be required|optional|none (got "${ ec.auth }")`);
      }
    }

    // 3. INTEGRATION.md is optional but recommended.
    if (!fs.existsSync(path.join(dir, 'INTEGRATION.md'))) {
      issues.push('Note: INTEGRATION.md is missing. Highly recommended — agents read it to understand what the integration does.');
    }

    return issues;
  }

  void KIND_LAYOUTS; // keeps the import referenced if all kinds short-circuit above
  return issues;
}
