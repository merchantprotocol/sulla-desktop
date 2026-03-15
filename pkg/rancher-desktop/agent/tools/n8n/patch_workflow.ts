import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import {
  cloneWorkflowGraph,
  countNodeConnections,
  ensureNodeId,
  ensureUniqueNodeName,
  removeNodeFromConnections,
  resolveNodeIndex,
  rewriteConnectionsForNodeRename,
} from './workflow_node_utils';

type JsonRecord = Record<string, any>;
type PatchOp = 'add' | 'update' | 'remove';
type PatchTarget = 'node' | 'connection';
interface ConnectionIssue { issue: string; detail: string }

interface NormalizedNodeOperation {
  target:    'node';
  op:        PatchOp;
  node?:     JsonRecord;
  nodeId?:   string;
  nodeName?: string;
  patch?:    JsonRecord;
}

interface NormalizedConnectionOperation {
  target:           'connection';
  op:               'add' | 'remove';
  source:           string;
  connectionTarget: string;
  sourceIndex:      number;
  targetIndex:      number;
}

type NormalizedOperation = NormalizedNodeOperation | NormalizedConnectionOperation;

function ensureRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value: any): any {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry));
  }
  if (isPlainObject(value)) {
    const clone: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = deepClone(entry);
    }
    return clone;
  }
  return value;
}

function deepMergeRecords(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const merged: JsonRecord = deepClone(base);

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }

    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      merged[key] = deepMergeRecords(baseValue, patchValue);
      continue;
    }

    // Arrays and primitive values are replaced to match caller intent exactly.
    merged[key] = deepClone(patchValue);
  }

  return merged;
}

function isSubsetMatch(expected: any, actual: any): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) {
      return false;
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (!isSubsetMatch(expected[i], actual[i])) {
        return false;
      }
    }
    return true;
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (!(key in actual)) {
        return false;
      }
      if (!isSubsetMatch(expectedValue, (actual)[key])) {
        return false;
      }
    }
    return true;
  }

  return expected === actual;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      return false;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function parseJsonIfString(value: any, field: string): any {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${ field }: ${ (error as Error).message }`);
  }
}

function normalizePatchTarget(rec: JsonRecord): PatchTarget {
  const explicit = String(rec.targetType || rec.entity || rec.resource || rec.target || '').trim().toLowerCase();
  if (explicit === 'node' || explicit === 'connection') {
    return explicit;
  }

  if (rec.node !== undefined || rec.nodeId !== undefined || rec.nodeName !== undefined || rec.patch !== undefined) {
    return 'node';
  }

  if (rec.source !== undefined || rec.sourceNodeName !== undefined) {
    return 'connection';
  }

  throw new Error('Unable to infer operation target. Provide target as node or connection.');
}

function normalizeConnectionTargetSpec(
  rec: JsonRecord,
  index: number,
  targetWasExplicit: boolean,
): { connectionTarget: string; targetIndexFromTarget?: number } {
  const rawTarget =
    rec.connectionTarget ??
    rec.targetNodeName ??
    rec.targetNode ??
    rec.to ??
    rec.destination ??
    (!targetWasExplicit ? rec.target : undefined);

  if (rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget)) {
    const targetObj = ensureRecord(rawTarget);
    const connectionTarget = String(
      targetObj.node ||
      targetObj.name ||
      targetObj.target ||
      targetObj.targetNodeName ||
      '',
    ).trim();

    if (!connectionTarget) {
      throw new Error(`operations[${ index }].connectionTarget object must include node/name/target.`);
    }

    const rawTargetIndex = targetObj.index ?? targetObj.targetIndex ?? targetObj.inputIndex;
    if (rawTargetIndex === undefined || rawTargetIndex === null || String(rawTargetIndex).trim() === '') {
      return { connectionTarget };
    }

    const targetIndexFromTarget = Number(rawTargetIndex);
    if (!Number.isInteger(targetIndexFromTarget) || targetIndexFromTarget < 0) {
      throw new Error(`operations[${ index }].connectionTarget.index must be a non-negative integer.`);
    }

    return { connectionTarget, targetIndexFromTarget };
  }

  const connectionTarget = String(rawTarget || '').trim();
  return { connectionTarget };
}

function normalizeOperations(rawOperations: unknown): NormalizedOperation[] {
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error('operations is required and must be a non-empty array.');
  }
  if (rawOperations.length > 250) {
    throw new Error('operations is too large. Maximum allowed operations per call is 250.');
  }

  return rawOperations.map((raw, index) => {
    const parsed = parseJsonIfString(raw, `operations[${ index }]`);
    const rec = ensureRecord(parsed);
    const op = String(rec.op || '').trim().toLowerCase();

    if (op !== 'add' && op !== 'update' && op !== 'remove') {
      throw new Error(`operations[${ index }].op must be one of: add, update, remove.`);
    }

    const explicitTarget = String(rec.targetType || rec.entity || rec.resource || rec.target || '').trim().toLowerCase();
    const target = normalizePatchTarget(rec);

    if (target === 'node') {
      if (op === 'add') {
        const node = parseJsonIfString(rec.node, `operations[${ index }].node`);
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
          throw new Error(`operations[${ index }].node must be an object for node add.`);
        }
        if (!String(node.type || '').trim() || !Array.isArray(node.position)) {
          throw new Error(`operations[${ index }].node must include at least type and position for node add.`);
        }
        return { target: 'node', op: 'add', node };
      }

      if (op === 'update') {
        const nodeId = String(rec.nodeId || '').trim();
        const nodeName = String(rec.nodeName || '').trim();
        const node = rec.node !== undefined ? parseJsonIfString(rec.node, `operations[${ index }].node`) : undefined;
        const patch = parseJsonIfString(rec.patch, `operations[${ index }].patch`);

        if (!nodeId && !nodeName) {
          throw new Error(`operations[${ index }] node update requires nodeId or nodeName.`);
        }
        if (node !== undefined && (typeof node !== 'object' || node === null || Array.isArray(node))) {
          throw new Error(`operations[${ index }].node must be an object when provided for node update.`);
        }
        if (patch !== undefined && (!patch || typeof patch !== 'object' || Array.isArray(patch))) {
          throw new Error(`operations[${ index }].patch must be an object for node update.`);
        }
        if (node === undefined && patch === undefined) {
          throw new Error(`operations[${ index }] node update requires either patch or node.`);
        }

        return { target: 'node', op: 'update', nodeId, nodeName, patch, node: node as JsonRecord | undefined };
      }

      const nodeId = String(rec.nodeId || '').trim();
      const nodeName = String(rec.nodeName || '').trim();
      if (!nodeId && !nodeName) {
        throw new Error(`operations[${ index }] node remove requires nodeId or nodeName.`);
      }

      return { target: 'node', op: 'remove', nodeId, nodeName };
    }

    if (op === 'update') {
      throw new Error(`operations[${ index }] connection target does not support op=update. Use add/remove.`);
    }

    const source = String(rec.source || rec.connectionSource || rec.sourceNodeName || '').trim();
    const targetSpec = normalizeConnectionTargetSpec(
      rec,
      index,
      explicitTarget === 'connection' || explicitTarget === 'node',
    );
    const connectionTarget = targetSpec.connectionTarget;
    const sourceIndex = Number(rec.sourceIndex ?? rec.sourceOutputIndex ?? 0);
    const targetIndex = Number(rec.targetIndex ?? rec.targetInputIndex ?? targetSpec.targetIndexFromTarget ?? 0);

    if (!source) {
      throw new Error(`operations[${ index }].source is required for connection operations (accepted aliases: source, connectionSource, sourceNodeName).`);
    }
    if (!connectionTarget) {
      throw new Error(`operations[${ index }] connection destination is required (use connectionTarget string or connectionTarget object with node).`);
    }
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
      throw new Error(`operations[${ index }].sourceIndex must be a non-negative integer.`);
    }
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
      throw new Error(`operations[${ index }].targetIndex must be a non-negative integer.`);
    }

    return {
      target: 'connection',
      op,
      source,
      connectionTarget,
      sourceIndex,
      targetIndex,
    };
  });
}

function asEdgeArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as JsonRecord[];
}

function collectConnectionIssues(connectionsRaw: unknown, nodeNames: Set<string>): ConnectionIssue[] {
  const issues: ConnectionIssue[] = [];
  const connections = ensureRecord(connectionsRaw);

  for (const [sourceNode, byTypeRaw] of Object.entries(connections)) {
    if (!nodeNames.has(sourceNode)) {
      issues.push({ issue: 'source_node_missing', detail: `Connection source node missing: ${ sourceNode }` });
    }

    const byType = ensureRecord(byTypeRaw);
    for (const [sourceType, outputBucketsRaw] of Object.entries(byType)) {
      const outputBuckets = Array.isArray(outputBucketsRaw)
        ? outputBucketsRaw
        : Object.values(ensureRecord(outputBucketsRaw));

      outputBuckets.forEach((targetsRaw, sourceOutputIndex) => {
        if (!Array.isArray(targetsRaw)) {
          issues.push({
            issue:  'malformed_output_bucket',
            detail: `${ sourceNode }.${ sourceType }[${ sourceOutputIndex }] is not an array`,
          });
          return;
        }

        const targets = asEdgeArray(targetsRaw);
        for (const target of targets) {
          const targetNode = String(target.node || '').trim();
          const targetIndex = Number(target.index ?? 0);

          if (!targetNode) {
            issues.push({
              issue:  'missing_target_node',
              detail: `${ sourceNode }.${ sourceType }[${ sourceOutputIndex }] edge has empty target node`,
            });
            continue;
          }

          if (!nodeNames.has(targetNode)) {
            issues.push({
              issue:  'target_node_missing',
              detail: `${ sourceNode }.${ sourceType }[${ sourceOutputIndex }] references missing target node: ${ targetNode }`,
            });
          }

          if (!Number.isInteger(targetIndex) || targetIndex < 0) {
            issues.push({
              issue:  'invalid_target_index',
              detail: `${ sourceNode }.${ sourceType }[${ sourceOutputIndex }] -> ${ targetNode } has invalid target index`,
            });
          }
        }
      });
    }
  }

  return issues;
}

function getMainOutputEdges(connections: JsonRecord, sourceNode: string, sourceIndex: number): any[] {
  const sourceNodeMap = ensureRecord(connections[sourceNode]);
  connections[sourceNode] = sourceNodeMap;

  const typeBucketsRaw = sourceNodeMap.main;
  const typeBuckets: any[] = Array.isArray(typeBucketsRaw) ? typeBucketsRaw : [];
  sourceNodeMap.main = typeBuckets;

  while (typeBuckets.length <= sourceIndex) {
    typeBuckets.push([]);
  }

  const outputEdgesRaw = typeBuckets[sourceIndex];
  const outputEdges: any[] = Array.isArray(outputEdgesRaw) ? outputEdgesRaw : [];
  typeBuckets[sourceIndex] = outputEdges;

  return outputEdges;
}

function countMatchingMainEdges(outputEdges: any[], op: NormalizedConnectionOperation): number {
  return outputEdges.filter((edge) =>
    String(edge?.node || '').trim() === op.connectionTarget &&
    Number(edge?.index ?? -1) === op.targetIndex &&
    String(edge?.type || 'main').trim() === 'main',
  ).length;
}

function connectionExists(connectionsRaw: unknown, source: string, connectionTarget: string, sourceIndex: number, targetIndex: number): boolean {
  const connections = ensureRecord(connectionsRaw);
  const sourceNodeMap = ensureRecord(connections[source]);
  const typeBuckets = Array.isArray(sourceNodeMap.main) ? sourceNodeMap.main : [];
  const outputEdges = Array.isArray(typeBuckets[sourceIndex]) ? typeBuckets[sourceIndex] : [];

  return outputEdges.some((edge) =>
    String(edge?.node || '').trim() === connectionTarget &&
    Number(edge?.index ?? -1) === targetIndex &&
    String(edge?.type || 'main').trim() === 'main',
  );
}

export class PatchWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        throw new Error('workflowId is required.');
      }

      const operations = normalizeOperations(input.operations);

      const service = await createN8nService();
      const workflow = await service.getWorkflow(workflowId, true);
      const graph = cloneWorkflowGraph(workflow);
      const originalSnapshot = {
        name:        graph.name,
        nodes:       deepClone(graph.nodes),
        connections: deepClone(graph.connections),
        settings:    deepClone(graph.settings),
        staticData:  deepClone(graph.staticData),
      };

      const nodeNames = new Set(
        (Array.isArray(graph.nodes) ? graph.nodes : [])
          .map((node) => String(node?.name || '').trim())
          .filter(Boolean),
      );

      if (nodeNames.size === 0) {
        throw new Error('Workflow has no nodes; cannot patch safely.');
      }

      graph.connections = ensureRecord(graph.connections);

      const preflightIssues = collectConnectionIssues(graph.connections, nodeNames);
      if (preflightIssues.length > 0) {
        const details = preflightIssues.slice(0, 8).map((issue) => `${ issue.issue }: ${ issue.detail }`).join('; ');
        throw new Error(`Workflow connections preflight failed; refusing patch. ${ details }`);
      }

      const results: any[] = [];

      for (const operation of operations) {
        if (operation.target === 'node') {
          if (operation.op === 'add') {
            const rawNode = operation.node!;
            const nodeName = ensureUniqueNodeName(rawNode.name || 'New Node', graph.nodes);
            const nodeId = ensureNodeId(rawNode.id, nodeName, graph.nodes);
            const nodeToInsert = { ...rawNode, id: nodeId, name: nodeName };
            graph.nodes.push(nodeToInsert);
            nodeNames.add(nodeName);

            results.push({
              target:           'node',
              op:               'add',
              changed:          true,
              insertedNodeId:   nodeId,
              insertedNodeName: nodeName,
              insertIndex:      graph.nodes.length - 1,
            });
            continue;
          }

          const nodeIndex = resolveNodeIndex(graph.nodes, {
            nodeId:   operation.nodeId,
            nodeName: operation.nodeName,
          });

          const existingNode = graph.nodes[nodeIndex];
          const oldName = String(existingNode?.name || '');

          if (operation.op === 'update') {
            const replacementNode = operation.node ? ensureRecord(operation.node) : null;
            const patchObject = operation.patch ? ensureRecord(operation.patch) : {};

            const mergedNode = replacementNode
              ? {
                ...deepClone(ensureRecord(existingNode)),
                ...deepClone(replacementNode),
              }
              : deepMergeRecords(ensureRecord(existingNode), patchObject);

            // Critical for complex nodes (e.g. Set v3.4): when parameters are present in patch,
            // replace parameters wholesale to avoid stale nested schema fragments.
            if (patchObject.parameters !== undefined) {
              mergedNode.parameters = deepClone(patchObject.parameters);
            }

            if (operation.patch?.name !== undefined || replacementNode?.name !== undefined) {
              const requestedName = String(
                (replacementNode?.name !== undefined ? replacementNode.name : operation.patch?.name) || '',
              );
              mergedNode.name = ensureUniqueNodeName(requestedName, graph.nodes, String(existingNode.id || ''));
            }

            graph.nodes[nodeIndex] = mergedNode;
            const newName = String(mergedNode.name || '');

            if (oldName && newName && oldName !== newName) {
              graph.connections = rewriteConnectionsForNodeRename(graph.connections, oldName, newName);
              nodeNames.delete(oldName);
              nodeNames.add(newName);
            }

            results.push({
              target:           'node',
              op:               'update',
              changed:          true,
              nodeIndex,
              appliedPatch:     replacementNode ? mergedNode : patchObject,
              previousNodeName: oldName,
              updatedNodeName:  newName,
              updatedNodeId:    mergedNode.id,
            });
            continue;
          }

          const [removedNode] = graph.nodes.splice(nodeIndex, 1);
          const removedName = String(removedNode?.name || oldName || '');
          const removedConnectionSummary = countNodeConnections(graph.connections || {}, removedName);
          graph.connections = removeNodeFromConnections(graph.connections, removedName);
          nodeNames.delete(removedName);

          results.push({
            target:             'node',
            op:                 'remove',
            changed:            true,
            removedNodeId:      removedNode?.id,
            removedNodeName:    removedName,
            removedNodeIndex:   nodeIndex,
            removedConnections: removedConnectionSummary,
          });
          continue;
        }

        if (!nodeNames.has(operation.source)) {
          throw new Error(`Source node not found: ${ operation.source }`);
        }
        if (!nodeNames.has(operation.connectionTarget)) {
          throw new Error(`Target node not found: ${ operation.connectionTarget }`);
        }

        const outputEdges = getMainOutputEdges(graph.connections, operation.source, operation.sourceIndex);
        const beforeCount = countMatchingMainEdges(outputEdges, operation);

        if (operation.op === 'add') {
          if (beforeCount === 0) {
            outputEdges.push({
              node:  operation.connectionTarget,
              type:  'main',
              index: operation.targetIndex,
            });
          }

          const afterCount = countMatchingMainEdges(outputEdges, operation);
          if (afterCount < 1) {
            throw new Error(`Patch add verification failed for ${ operation.source } -> ${ operation.connectionTarget }.`);
          }

          results.push({
            target:             'connection',
            op:                 'add',
            source:             operation.source,
            connectionTarget:   operation.connectionTarget,
            sourceIndex:        operation.sourceIndex,
            targetIndex:        operation.targetIndex,
            changed:            beforeCount === 0,
            matchedCountBefore: beforeCount,
            matchedCountAfter:  afterCount,
          });
          continue;
        }

        const nextOutputEdges = outputEdges.filter((edge) => {
          const sameTarget = String(edge?.node || '').trim() === operation.connectionTarget;
          const sameIndex = Number(edge?.index ?? -1) === operation.targetIndex;
          const sameType = String(edge?.type || 'main').trim() === 'main';
          return !(sameTarget && sameIndex && sameType);
        });

        const sourceNodeMap = ensureRecord(graph.connections[operation.source]);
        const typeBuckets = Array.isArray(sourceNodeMap.main) ? sourceNodeMap.main : [];
        sourceNodeMap.main = typeBuckets;
        typeBuckets[operation.sourceIndex] = nextOutputEdges;

        const afterEdges = getMainOutputEdges(graph.connections, operation.source, operation.sourceIndex);
        const afterCount = countMatchingMainEdges(afterEdges, operation);
        if (afterCount !== 0) {
          throw new Error(`Patch remove verification failed for ${ operation.source } -> ${ operation.connectionTarget }.`);
        }

        const matchedCount = outputEdges.length - nextOutputEdges.length;
        results.push({
          target:             'connection',
          op:                 'remove',
          source:             operation.source,
          connectionTarget:   operation.connectionTarget,
          sourceIndex:        operation.sourceIndex,
          targetIndex:        operation.targetIndex,
          changed:            matchedCount > 0,
          matchedCountBefore: beforeCount,
          matchedCountAfter:  afterCount,
        });
      }

      const postPatchIssues = collectConnectionIssues(graph.connections, nodeNames);
      if (postPatchIssues.length > 0) {
        const details = postPatchIssues.slice(0, 8).map((issue) => `${ issue.issue }: ${ issue.detail }`).join('; ');
        throw new Error(`Workflow connections failed post-patch validation. ${ details }`);
      }

      const changedCount = results.filter((result) => result.changed).length;
      const netChanged = !deepEqual(originalSnapshot, {
        name:        graph.name,
        nodes:       graph.nodes,
        connections: graph.connections,
        settings:    graph.settings,
        staticData:  graph.staticData,
      });

      if (changedCount === 0 || !netChanged) {
        return {
          successBoolean: true,
          responseString: JSON.stringify({
            workflowId:          String(workflow?.id || workflowId),
            patchedCount:        0,
            skippedUpdate:       true,
            skippedUpdateReason: changedCount === 0 ? 'no_effective_operations' : 'net_noop_after_patch_sequence',
            operations:          results,
          }, null, 2),
        };
      }

      const updated = await service.updateWorkflow(workflow.id, {
        name:        graph.name,
        nodes:       graph.nodes,
        connections: graph.connections,
        settings:    graph.settings,
        staticData:  graph.staticData,
      });

      // Read-after-write verification to prevent silent no-op success responses.
      const persisted = await service.getWorkflow(updated.id || workflow.id, true);
      const persistedNodes = Array.isArray(persisted?.nodes) ? persisted.nodes : [];
      const persistedConnections = ensureRecord(persisted?.connections);
      const persistedNodeIds = new Set(persistedNodes.map((node: any) => String(node?.id || '').trim()).filter(Boolean));
      const persistedNodeNames = new Set(persistedNodes.map((node: any) => String(node?.name || '').trim()).filter(Boolean));

      for (const result of results) {
        if (!result.changed) {
          continue;
        }

        if (result.target === 'connection') {
          const exists = connectionExists(
            persistedConnections,
            String(result.source || ''),
            String(result.connectionTarget || ''),
            Number(result.sourceIndex ?? 0),
            Number(result.targetIndex ?? 0),
          );

          if (result.op === 'add' && !exists) {
            throw new Error(`Post-save verification failed: connection add was not persisted (${ result.source } -> ${ result.connectionTarget }).`);
          }
          if (result.op === 'remove' && exists) {
            throw new Error(`Post-save verification failed: connection remove was not persisted (${ result.source } -> ${ result.connectionTarget }).`);
          }
          continue;
        }

        if (result.target === 'node' && result.op === 'add') {
          const id = String(result.insertedNodeId || '').trim();
          const name = String(result.insertedNodeName || '').trim();
          if ((id && !persistedNodeIds.has(id)) || (name && !persistedNodeNames.has(name))) {
            throw new Error(`Post-save verification failed: node add was not persisted (${ name || id }).`);
          }
          continue;
        }

        if (result.target === 'node' && result.op === 'update') {
          const id = String(result.updatedNodeId || '').trim();
          const name = String(result.updatedNodeName || '').trim();
          if ((id && !persistedNodeIds.has(id)) || (name && !persistedNodeNames.has(name))) {
            throw new Error(`Post-save verification failed: node update was not persisted (${ name || id }).`);
          }

          const persistedNode = persistedNodes.find((node: any) => {
            const nodeId = String(node?.id || '').trim();
            const nodeName = String(node?.name || '').trim();
            return (id && nodeId === id) || (!!name && nodeName === name);
          });

          if (!persistedNode) {
            throw new Error(`Post-save verification failed: updated node could not be located (${ name || id }).`);
          }

          if (!isSubsetMatch(ensureRecord(result.appliedPatch), persistedNode)) {
            throw new Error(`Post-save verification failed: node patch fields were not persisted (${ name || id }).`);
          }
          continue;
        }

        if (result.target === 'node' && result.op === 'remove') {
          const id = String(result.removedNodeId || '').trim();
          const name = String(result.removedNodeName || '').trim();
          if ((id && persistedNodeIds.has(id)) || (name && persistedNodeNames.has(name))) {
            throw new Error(`Post-save verification failed: node remove was not persisted (${ name || id }).`);
          }
        }
      }

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          workflowId:    updated.id,
          patchedCount:  changedCount,
          skippedUpdate: false,
          operations:    results,
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error patching workflow: ${ (error as Error).message }`,
      };
    }
  }
}
