import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';
import { DEPS_FILES, RUNTIME_URLS } from './constants';

async function runtimePost(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ detail: `non-JSON response (status ${ res.status })` }));
  if (!res.ok) {
    const detail = (json as any)?.detail ?? JSON.stringify(json);
    throw new Error(`HTTP ${ res.status }: ${ detail }`);
  }
  return json;
}

export class FunctionRunWorker extends BaseTool {
  name = 'function_run';
  description = 'Load and invoke a custom function by slug. Returns the function metadata, runtime details, load status, inputs used, and all outputs in one call.';

  schemaDef = {
    slug: {
      type:        'string' as const,
      description: 'The function slug (directory name under ~/sulla/functions/).',
    },
    inputs: {
      type:        'object' as const,
      optional:    true,
      description: 'Input key/value pairs to pass to the function. Defaults to empty (uses function defaults).',
    },
    version: {
      type:        'string' as const,
      optional:    true,
      description: 'Version string to pass to the runtime loader. Defaults to "1.0.0".',
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug: string = input.slug;
    const inputs: Record<string, unknown> = (input.inputs && typeof input.inputs === 'object') ? input.inputs : {};
    const version: string = input.version || '1.0.0';

    const lines: string[] = [];
    const fail = (msg: string): ToolResponse => ({
      successBoolean: false,
      responseString: lines.join('\n') + '\n\n❌ ' + msg,
    });

    // ── 1. Locate function ──
    const { resolveSullaFunctionsDir } = await import('@pkg/agent/utils/sullaPaths');
    const functionsDir = resolveSullaFunctionsDir();
    const fnDir = path.join(functionsDir, slug);
    const yamlPath = path.join(fnDir, 'function.yaml');

    lines.push(`Function: ${ slug }`);
    lines.push(`Manifest: ${ yamlPath }`);

    if (!fs.existsSync(yamlPath)) {
      return fail(`function.yaml not found at ${ yamlPath }. Run \`function_list\` to see available functions.`);
    }

    // ── 2. Parse manifest ──
    let manifest: any;
    try {
      manifest = yaml.parse(fs.readFileSync(yamlPath, 'utf-8')) || {};
    } catch (err) {
      return fail(`Failed to parse function.yaml: ${ (err as Error).message }`);
    }

    const spec = manifest.spec ?? {};
    const runtime: string = spec.runtime || '';
    const entrypoint: string = spec.entrypoint || '';
    const fnName: string = typeof manifest.name === 'string' ? manifest.name : slug;
    const fnDescription: string = typeof manifest.description === 'string' ? manifest.description.trim() : '';
    const timeout: string = spec.timeout || '60s';
    const declaredInputs: Record<string, any> = spec.inputs || {};
    const declaredOutputs: Record<string, any> = spec.outputs || {};

    lines.push(`Name:        ${ fnName }`);
    if (fnDescription) lines.push(`Description: ${ fnDescription.split('\n')[0] }`);
    lines.push(`Runtime:     ${ runtime || '(missing)' }`);
    lines.push(`Entrypoint:  ${ entrypoint || '(missing)' }`);
    lines.push(`Timeout:     ${ timeout }`);
    if (Object.keys(declaredInputs).length) {
      lines.push(`Inputs declared: ${ Object.keys(declaredInputs).join(', ') }`);
    }
    if (Object.keys(declaredOutputs).length) {
      lines.push(`Outputs declared: ${ Object.keys(declaredOutputs).join(', ') }`);
    }

    const runtimeUrl = RUNTIME_URLS[runtime];
    if (!runtimeUrl) {
      return fail(`Unknown runtime "${ runtime }". Must be one of: ${ Object.keys(RUNTIME_URLS).join(', ') }.`);
    }

    lines.push(`Runtime URL: ${ runtimeUrl }`);
    lines.push('');

    // ── 3. Install dependencies ──
    const depsFile = DEPS_FILES[runtime];
    if (depsFile) {
      const depsPath = path.join(fnDir, depsFile);
      if (fs.existsSync(depsPath)) {
        lines.push(`Step 1 — Installing dependencies from ${ depsFile }...`);
        try {
          const installResult = await runtimePost(`${ runtimeUrl }/install`, { name: slug, version });
          const summary = installResult.message
            ?? (installResult.installed ? `${ installResult.packages ?? 0 } packages installed` : 'already up-to-date');
          lines.push(`✓ ${ summary }`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith('HTTP 404') || msg.startsWith('HTTP 405')) {
            lines.push(`⚠️  Runtime does not support /install — skipping (upgrade the runtime image to enable dependency installation)`);
          } else {
            return fail(`Dependency installation failed: ${ msg }`);
          }
        }
        lines.push('');
      }
    }

    // ── 4. Load ──
    const loadStep = depsFile && fs.existsSync(path.join(fnDir, depsFile)) ? 2 : 1;
    lines.push(`Step ${ loadStep } — Loading function into runtime...`);
    let loadResult: any;
    try {
      loadResult = await runtimePost(`${ runtimeUrl }/load`, { name: slug, version });
      lines.push(`✓ Loaded — entrypoint: ${ loadResult.entrypoint }, version: ${ loadResult.version }`);
    } catch (err) {
      return fail(`Load failed: ${ (err as Error).message }`);
    }

    lines.push('');

    // ── 5. Invoke ──
    const invokeStep = loadStep + 1;
    const inputSummary = Object.keys(inputs).length
      ? JSON.stringify(inputs, null, 2)
      : '(none — using function defaults)';
    lines.push(`Step ${ invokeStep } — Invoking with inputs:\n${ inputSummary }`);

    let invokeResult: any;
    try {
      invokeResult = await runtimePost(`${ runtimeUrl }/invoke`, { name: slug, version, inputs });
    } catch (err) {
      return fail(`Invocation failed: ${ (err as Error).message }`);
    }

    const durationMs: number = invokeResult.duration_ms ?? 0;
    const outputs: Record<string, unknown> = invokeResult.outputs ?? {};

    lines.push(`✓ Completed in ${ durationMs }ms`);
    lines.push('');

    // ── 6. Format outputs ──
    lines.push('Outputs:');
    if (Object.keys(outputs).length === 0) {
      lines.push('  (none returned)');
    } else {
      for (const [key, val] of Object.entries(outputs)) {
        const valStr = typeof val === 'string' ? `"${ val }"` : JSON.stringify(val);
        lines.push(`  ${ key }: ${ valStr }`);
      }
    }

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
