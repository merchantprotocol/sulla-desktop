import { DomainError } from '../errors';
import { LaneKey, ProjectId, SemanticRole } from '../values';

export interface BoardLane {
  key: LaneKey;
  semanticRole: SemanticRole;
  position: number;
  enabled: boolean;
}

export class Board {
  readonly projectId: ProjectId;
  readonly lanes: readonly Readonly<BoardLane>[];

  constructor(projectId: ProjectId, lanes: readonly BoardLane[]) {
    const keys = lanes.map(lane => lane.key.value);
    if (new Set(keys).size !== keys.length) throw new DomainError('Board lane keys must be unique');
    if (lanes.some(lane => !Number.isInteger(lane.position) || lane.position < 0)) {
      throw new DomainError('Board lane positions must be non-negative integers');
    }
    this.projectId = projectId;
    this.lanes = Object.freeze([...lanes]
      .map(lane => Object.freeze({ ...lane }))
      .sort((a, b) => a.position - b.position));
    Object.freeze(this);
  }

  lane(key: LaneKey): Readonly<BoardLane> {
    const lane = this.lanes.find(candidate => candidate.key.equals(key));
    if (!lane || !lane.enabled) throw new DomainError(`Unknown or disabled lane: ${ key.value }`);
    return lane;
  }

  nextLane(key: LaneKey): Readonly<BoardLane> | null {
    const enabled = this.lanes.filter(lane => lane.enabled);
    const index = enabled.findIndex(lane => lane.key.equals(key));
    if (index < 0) throw new DomainError(`Unknown or disabled lane: ${ key.value }`);
    return enabled[index + 1] ?? null;
  }

  assertOperational(): void {
    const roles = new Set(this.lanes.filter(lane => lane.enabled).map(lane => lane.semanticRole.value));
    const missing = SemanticRole.REQUIRED.filter(role => !roles.has(role));
    if (missing.length > 0) throw new DomainError(`Board is missing required semantic roles: ${ missing.join(', ') }`);
  }
}
