import type { ToolExecutionContext } from '../../../pkg/rancher-desktop/agent/tools/executionContext.js';
import type { ToolExecutionTarget } from '../../../pkg/rancher-desktop/agent/tools/executionTargets.js';

export interface CatalogTool {
  name:            string;
  category:        string;
  description:     string;
  schemaDef:       Record<string, unknown>;
  executionTarget: ToolExecutionTarget;
}

let registry: typeof import('../../../pkg/rancher-desktop/agent/tools/registry.js').toolRegistry;
const tools = new Map<string, CatalogTool>();

export async function initializeCatalog(): Promise<void> {
  await import('../../../pkg/rancher-desktop/agent/tools/manifests.js');
  ({ toolRegistry: registry } = await import('../../../pkg/rancher-desktop/agent/tools/registry.js'));
  for (const { category } of registry.getCategoriesWithDescriptions()) {
    for (const name of registry.getToolNamesForCategory(category)) {
      tools.set(name, {
        name,
        category,
        description:     registry.getToolDescription(name),
        schemaDef:       registry.getSchemaDef(name) ?? {},
        executionTarget: registry.getExecutionTarget(name) ?? 'desktop-local',
      });
    }
  }
}

export function resolveTool(category: string, requested: string): CatalogTool | undefined {
  const tool = tools.get(`${ category }_${ requested }`) ?? tools.get(requested);

  return tool?.category === category ? tool : undefined;
}

export function listTools(category?: string): CatalogTool[] {
  return [...tools.values()].filter(tool => !category || tool.category === category).sort((a, b) => a.name.localeCompare(b.name));
}

export async function executeCatalogTool(ctx: ToolExecutionContext, tool: CatalogTool, args: unknown): Promise<unknown> {
  const worker = await registry.createTool(tool.name);
  worker.executionContext = ctx;
  return worker.call(args);
}
