import { Board, Epic, Project, Task } from '../entities';
import { DomainError } from '../errors';
import {
  ArtifactGeneration, EpicId, LaneKey, ProjectId, SemanticRole, TaskId,
} from '../values';

/** Structural legacy records keep this adapter independent from SQL model modules. */
export interface LegacyProjectRecord {
  id: string;
  title: string;
  archived: boolean;
}

export interface LegacyEpicRecord {
  id: string;
  project_id: string;
  title: string;
  archived: boolean;
}

export interface LegacyTaskRecord {
  id: string;
  project_id: string;
  epic_id: string | null;
  title: string;
  status: string;
  assignee: string | null;
  labels: string[] | null;
  archived: boolean;
}

export interface LegacyLaneRecord {
  lane_key: string;
  semantic_role?: string | null;
  position: number;
  enabled: boolean;
}

export interface LegacyArtifactIdentity {
  generation?: number | null;
  artifact_hash?: string | null;
}

export class LegacyProjectsMapper {
  static project(record: LegacyProjectRecord): Project {
    return new Project({ id: ProjectId.of(record.id), title: record.title, archived: record.archived });
  }

  static epic(record: LegacyEpicRecord): Epic {
    return new Epic({
      id: EpicId.of(record.id),
      projectId: ProjectId.of(record.project_id),
      title: record.title,
      archived: record.archived,
    });
  }

  static task(record: LegacyTaskRecord, artifact: LegacyArtifactIdentity = {}): Task {
    const lane = LaneKey.of(record.status);
    const semanticRole = SemanticRole.forLaneKey(lane.value);
    if (!semanticRole) {
      throw new DomainError(`Legacy task lane requires an explicit configured role: ${ lane.value }`);
    }
    return new Task({
      id: TaskId.of(record.id),
      projectId: ProjectId.of(record.project_id),
      epicId: record.epic_id ? EpicId.of(record.epic_id) : null,
      title: record.title,
      lane,
      semanticRole,
      artifactGeneration: ArtifactGeneration.of(artifact.generation ?? 0, artifact.artifact_hash),
      assignee: record.assignee,
      labels: record.labels ?? [],
      archived: record.archived,
    });
  }

  static board(projectId: string, records: readonly LegacyLaneRecord[]): Board {
    return new Board(ProjectId.of(projectId), records.map(record => {
      const key = LaneKey.of(record.lane_key);
      const role = SemanticRole.tryOf(record.semantic_role) ?? SemanticRole.forLaneKey(key.value);
      if (!role) throw new DomainError(`Lane requires a semantic role: ${ key.value }`);
      return { key, semanticRole: role, position: record.position, enabled: record.enabled };
    }));
  }
}
