export type WorkflowNode = Record<string, any>;

export interface WorkflowPayload {
  id?:         string;
  name:        string;
  active?:     boolean;
  nodes:       WorkflowNode[];
  connections: Record<string, any>;
  settings:    Record<string, any>;
  staticData?: Record<string, any>;
}

export interface NodeSelector {
  nodeId?:   string;
  nodeName?: string;
}

function normalizeNodeLookupToken(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function cloneWorkflowGraph(workflow: any): WorkflowPayload {
  return {
    id:          workflow?.id,
    name:        String(workflow?.name || ''),
    active:      !!workflow?.active,
    nodes:       Array.isArray(workflow?.nodes) ? JSON.parse(JSON.stringify(workflow.nodes)) : [],
    connections: workflow?.connections && typeof workflow.connections === 'object'
      ? JSON.parse(JSON.stringify(workflow.connections))
      : {},
    settings: workflow?.settings && typeof workflow.settings === 'object'
      ? JSON.parse(JSON.stringify(workflow.settings))
      : {},
    staticData: workflow?.staticData,
  };
}

export function resolveNodeIndex(nodes: WorkflowNode[], selector: NodeSelector): number {
  const nodeId = String(selector.nodeId || '').trim();
  const nodeName = String(selector.nodeName || '').trim();

  if (!nodeId && !nodeName) {
    throw new Error('Node selector is required: provide nodeId or nodeName.');
  }

  const nodeEntries = nodes.map((node, index) => ({ node, index }));

  const idMatches = nodeId
    ? nodeEntries.filter(({ node }) => String(node?.id || '') === nodeId)
    : [];

  if (nodeId && idMatches.length === 0) {
    throw new Error(`Node not found by nodeId: ${ nodeId }`);
  }

  if (nodeName) {
    const requestedNameLower = nodeName.toLowerCase();
    const requestedNameNormalized = normalizeNodeLookupToken(nodeName);

    let nameMatches = nodeEntries.filter(({ node }) => String(node?.name || '') === nodeName);

    if (nameMatches.length === 0) {
      nameMatches = nodeEntries.filter(({ node }) => String(node?.name || '').trim().toLowerCase() === requestedNameLower);
    }

    if (nameMatches.length === 0) {
      nameMatches = nodeEntries.filter(({ node }) => normalizeNodeLookupToken(node?.name) === requestedNameNormalized);
    }

    if (nameMatches.length === 0) {
      nameMatches = nodeEntries.filter(({ node }) => {
        const candidateId = String(node?.id || '').trim();
        return candidateId === nodeName || normalizeNodeLookupToken(candidateId) === requestedNameNormalized;
      });
    }

    if (nameMatches.length === 0 && requestedNameNormalized.length >= 3) {
      const containsMatches = nodeEntries.filter(({ node }) => {
        const candidateName = String(node?.name || '').trim();
        const candidateNormalized = normalizeNodeLookupToken(candidateName);
        return candidateName.toLowerCase().includes(requestedNameLower) || candidateNormalized.includes(requestedNameNormalized);
      });

      if (containsMatches.length === 1) {
        nameMatches = containsMatches;
      } else if (!nodeId && containsMatches.length > 1) {
        const candidates = containsMatches
          .slice(0, 8)
          .map(({ node }) => String(node?.name || node?.id || ''))
          .filter(Boolean)
          .join(', ');
        throw new Error(`Node name is ambiguous: ${ nodeName }. Matching candidates: ${ candidates }. Provide nodeId instead.`);
      }
    }

    if (nameMatches.length === 0 && !nodeId) {
      const availableNodes = nodeEntries
        .slice(0, 12)
        .map(({ node }) => String(node?.name || node?.id || ''))
        .filter(Boolean)
        .join(', ');
      throw new Error(`Node not found by nodeName: ${ nodeName }. Available nodes: ${ availableNodes }`);
    }

    if (!nodeId && nameMatches.length > 1) {
      const candidates = nameMatches
        .slice(0, 8)
        .map(({ node }) => String(node?.name || node?.id || ''))
        .filter(Boolean)
        .join(', ');
      throw new Error(`Node name is ambiguous: ${ nodeName }. Matching candidates: ${ candidates }. Provide nodeId instead.`);
    }

    if (nodeId) {
      const idMatch = idMatches[0];
      const idMatchName = String(idMatch.node?.name || '');
      const namesMatch = idMatchName === nodeName || normalizeNodeLookupToken(idMatchName) === requestedNameNormalized;
      if (!namesMatch) {
        throw new Error(`Node selector mismatch: nodeId ${ nodeId } does not match nodeName ${ nodeName }.`);
      }
      return idMatch.index;
    }

    return nameMatches[0].index;
  }

  return idMatches[0].index;
}

export function slugifyNodeToken(input: string): string {
  const token = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return token || 'node';
}

export function ensureUniqueNodeName(desiredName: string, existingNodes: WorkflowNode[], currentNodeId?: string): string {
  const baseName = String(desiredName || '').trim() || 'New Node';
  const usedNames = new Set(
    existingNodes
      .filter(node => !currentNodeId || String(node?.id || '') !== currentNodeId)
      .map(node => String(node?.name || '').trim())
      .filter(Boolean),
  );

  if (!usedNames.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  let candidate = `${ baseName } (${ suffix })`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${ baseName } (${ suffix })`;
  }

  return candidate;
}

export function ensureNodeId(desiredId: unknown, fallbackName: string, existingNodes: WorkflowNode[]): string {
  const candidateId = String(desiredId || '').trim();
  const usedIds = new Set(existingNodes.map(node => String(node?.id || '').trim()).filter(Boolean));

  if (candidateId && !usedIds.has(candidateId)) {
    return candidateId;
  }

  const token = slugifyNodeToken(fallbackName);
  let sequence = 1;
  let generated = `${ token }-${ sequence }`;

  while (usedIds.has(generated)) {
    sequence += 1;
    generated = `${ token }-${ sequence }`;
  }

  return generated;
}

export function computeInsertIndex(
  currentLength: number,
  mode: 'append' | 'before' | 'after',
  anchorIndex?: number,
): number {
  if (mode === 'append') {
    return currentLength;
  }

  if (anchorIndex === undefined || anchorIndex < 0 || anchorIndex >= currentLength) {
    throw new Error(`Anchor node is required for insert mode ${ mode }.`);
  }

  if (mode === 'before') {
    return anchorIndex;
  }

  return anchorIndex + 1;
}

export function rewriteConnectionsForNodeRename(connections: Record<string, any>, oldName: string, newName: string): Record<string, any> {
  const rewritten = JSON.parse(JSON.stringify(connections || {}));

  if (Object.prototype.hasOwnProperty.call(rewritten, oldName)) {
    rewritten[newName] = rewritten[oldName];
    delete rewritten[oldName];
  }

  const rewriteValue = (value: any): any => {
    if (Array.isArray(value)) {
      return value.map(rewriteValue);
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const copy: Record<string, any> = { ...value };
    if (typeof copy.node === 'string' && copy.node === oldName) {
      copy.node = newName;
    }

    for (const key of Object.keys(copy)) {
      copy[key] = rewriteValue(copy[key]);
    }

    return copy;
  };

  return rewriteValue(rewritten);
}

export function removeNodeFromConnections(connections: Record<string, any>, removedName: string): Record<string, any> {
  const rewritten = JSON.parse(JSON.stringify(connections || {}));
  if (Object.prototype.hasOwnProperty.call(rewritten, removedName)) {
    delete rewritten[removedName];
  }

  const rewriteValue = (value: any): any => {
    if (Array.isArray(value)) {
      const mapped = value
        .map(rewriteValue)
        .filter((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return true;
          }

          return !(typeof entry.node === 'string' && entry.node === removedName);
        });

      return mapped;
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const copy: Record<string, any> = { ...value };
    for (const key of Object.keys(copy)) {
      copy[key] = rewriteValue(copy[key]);
    }

    return copy;
  };

  return rewriteValue(rewritten);
}

export function countNodeConnections(connections: Record<string, any>, nodeName: string): { inbound: number; outbound: number } {
  const sourceGraph = connections || {};
  let inbound = 0;
  let outbound = 0;

  const walk = (value: any, sourceName?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, sourceName);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    if (typeof value.node === 'string') {
      if (value.node === nodeName) {
        inbound += 1;
      }
      if (sourceName === nodeName) {
        outbound += 1;
      }
    }

    for (const key of Object.keys(value)) {
      walk(value[key], sourceName);
    }
  };

  for (const [sourceName, sourceValue] of Object.entries(sourceGraph)) {
    walk(sourceValue, sourceName);
  }

  return { inbound, outbound };
}
