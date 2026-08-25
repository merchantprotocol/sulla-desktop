import fs from 'node:fs';
import path from 'node:path';

import { LaneKey, SemanticRole, TaskStatus } from '../values';

const repoRoot = process.cwd();
const laneModelSource = fs.readFileSync(path.join(
  repoRoot, 'pkg/rancher-desktop/agent/database/models/WorkLaneDefinitionModel.ts',
), 'utf8');
const workItemsSource = fs.readFileSync(path.join(
  repoRoot, 'pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts',
), 'utf8');

function requiredBlock(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`Canonical source block not found: ${ label }`);
  return match[1];
}

describe('Projects canonical legacy characterization', () => {
  it('derives default lane keys and roles from the canonical model source', () => {
    const block = requiredBlock(
      laneModelSource, /export const DEFAULT_WORK_LANES[^=]*= \[([\s\S]*?)\] as const;/,
      'DEFAULT_WORK_LANES',
    );
    const rows = [...block.matchAll(/lane_key: '([^']+)'.*semantic_role: '([^']+)'/g)]
      .map(match => ({ key: match[1], role: match[2] }));

    expect(rows.length).toBeGreaterThan(0);
    expect([...LaneKey.SYSTEM]).toEqual(rows.map(row => row.key));
    for (const row of rows) {
      expect(SemanticRole.forLaneKey(row.key)?.value).toBe(row.role);
    }
  });

  it('derives required roles from canonical system-required lanes', () => {
    const block = requiredBlock(
      laneModelSource, /export const DEFAULT_WORK_LANES[^=]*= \[([\s\S]*?)\] as const;/,
      'DEFAULT_WORK_LANES',
    );
    const requiredRoles = [...block.matchAll(/semantic_role: '([^']+)'.*system_required: true/g)]
      .map(match => match[1])
      .filter((role, index, roles) => roles.indexOf(role) === index);
    expect([...SemanticRole.REQUIRED]).toEqual(requiredRoles);
  });

  it('derives status-role compatibility from the canonical model source', () => {
    const block = requiredBlock(
      laneModelSource, /export const DEFAULT_STATUS_SEMANTIC_ROLE[^=]*= \{([\s\S]*?)\};/,
      'DEFAULT_STATUS_SEMANTIC_ROLE',
    );
    const mappings = [...block.matchAll(/^\s*([a-z_]+):\s*'([^']+)'/gm)]
      .map(match => ({ status: match[1], role: match[2] }));
    expect(mappings.map(mapping => mapping.status)).toEqual(TaskStatus.ALL.map(status => status.value));
    for (const mapping of mappings) {
      expect(TaskStatus.of(mapping.status).semanticRole().value).toBe(mapping.role);
    }
  });

  it('derives closed states from the canonical WorkItemsModel predicate', () => {
    const block = requiredBlock(
      workItemsSource, /const CLOSED_STATUSES = `status IN \(([^)]+)\)`;/,
      'CLOSED_STATUSES',
    );
    const closed = [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(TaskStatus.ALL.filter(status => status.isClosed()).map(status => status.value)).toEqual(closed);
  });
});
