import { randomUUID } from 'node:crypto';

import { postgresClient } from '../../database.js';
import { WorkLaneDefinitionModel } from './WorkLaneDefinitionModel.js';

export class ProjectsAuxiliaryModel {
  static async bootstrapTenant(actor = 'projects-service') {
    return postgresClient.transaction(async(client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('projects-bootstrap'), hashtext(current_setting('app.current_tenant')))");
      const inserted = await client.query(`INSERT INTO work_project_pipeline_templates
        (id,template_key,name,description,system,locked,enabled,created_by)
        VALUES('core-project-template-default','core-default-project','Sulla Default Project','Bundled configurable Projects pipeline.',true,true,true,$1)
        ON CONFLICT(tenant_id,id) DO NOTHING RETURNING id`, [actor]);
      const stages = [
        ['backlog','Backlog',0,'backlog'],['planning','Planning',10,'planning'],['todo','To Do',20,'execution'],
        ['in_progress','In Progress',30,'execution'],['in_review','In Review',40,'review'],['done','Done',50,'terminal'],
        ['blocked','Blocked',60,'blocked'],['parked','Parked',70,'manual'],['cancelled','Cancelled',80,'terminal'],
      ];
      for (const [key, name, position, role] of inserted.rowCount ? stages : []) {
        await client.query(`INSERT INTO work_project_pipeline_template_stages
          (id,template_id,stage_key,display_name,position,semantic_role)
          VALUES($1,'core-project-template-default',$2,$3,$4,$5)
          ON CONFLICT(tenant_id,template_id,stage_key) DO NOTHING`,
        [`core-stage-${ key }`,key,name,position,role]);
      }
      return WorkLaneDefinitionModel.seedDefaultsAndLegacyStatuses(actor);
    });
  }
  static listActiveTaskAgents(taskIds: string[] = []) {
    return postgresClient.query(`SELECT task_id,claimed_assignee AS agent_id,owner_subject,external_ref,expires_at
      FROM work_task_claims WHERE released_at IS NULL AND expires_at > now()
        AND (cardinality($1::text[]) = 0 OR task_id = ANY($1::text[])) ORDER BY task_id`, [taskIds]);
  }

  static claimDomainEvents(input: { consumerId: string; eventTypes?: string[]; limit?: number; leaseSeconds?: number }) {
    const limit = Math.max(1, Math.min(Number(input.limit ?? 25), 100));
    const leaseSeconds = Math.max(15, Math.min(Number(input.leaseSeconds ?? 60), 300));
    if (!input.consumerId?.trim()) throw new Error('consumerId is required');
    if (input.eventTypes !== undefined && (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0
      || input.eventTypes.length > 20 || input.eventTypes.some(value => typeof value !== 'string' || !value.trim()))) {
      throw new Error('eventTypes must be a non-empty list of event names');
    }
    return postgresClient.query(`WITH candidates AS (
      SELECT id FROM work_project_domain_events
       WHERE (status IN ('pending','failed') OR (status='processing' AND leased_until <= now())) AND available_at <= now()
         AND (leased_until IS NULL OR leased_until <= now())
         AND ($4::text[] IS NULL OR event_type=ANY($4::text[]))
       ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE work_project_domain_events AS event
       SET status='processing',attempts=attempts+1,lease_owner=$1,
           leased_until=now()+($3::text || ' seconds')::interval,updated_at=now()
      FROM candidates WHERE event.id=candidates.id
      RETURNING event.id,event.task_id,event.event_type,event.payload,event.occurred_at,event.attempts,event.leased_until`,
    [input.consumerId.trim(), limit, leaseSeconds, input.eventTypes?.map(value => value.trim()) ?? null]);
  }

  static async completeDomainEvents(ids: string[], consumerId: string) {
    if (!ids.length) return 0;
    const result = await postgresClient.query(`UPDATE work_project_domain_events
       SET status='completed',completed_at=now(),lease_owner=NULL,leased_until=NULL,last_error=NULL,updated_at=now()
     WHERE id=ANY($1::text[]) AND status='processing' AND lease_owner=$2 AND leased_until > now() RETURNING id`, [ids, consumerId]);
    return result.length;
  }

  static async failDomainEvents(ids: string[], consumerId: string, message: string) {
    if (!ids.length) return 0;
    const result = await postgresClient.query(`UPDATE work_project_domain_events
       SET status='failed',available_at=now()+interval '15 seconds',lease_owner=NULL,leased_until=NULL,
           last_error=$3,updated_at=now()
     WHERE id=ANY($1::text[]) AND status='processing' AND lease_owner=$2 AND leased_until > now() RETURNING id`,
    [ids, consumerId, message.slice(0, 2000)]);
    return result.length;
  }

  static async insertArtifactReceipt(input: Record<string, unknown>) {
    const rows = await postgresClient.query(`INSERT INTO work_artifact_receipts
      (id,receipt_version,task_id,event_type,actor,workflow_execution_id,dispatch_id,disposition,next_owner,
       validation_summary,artifacts,content_hashes,evidence_kind,evidence_ref,evidence_url,fingerprint,generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(tenant_id,task_id,fingerprint) DO NOTHING RETURNING *`, [
      input.id ?? randomUUID(), input.receiptVersion ?? 1, input.taskId, input.eventType, input.actor ?? null,
      input.workflowExecutionId ?? null, input.dispatchId ?? null, input.disposition ?? null, input.nextOwner ?? null,
      input.validationSummary ?? null, JSON.stringify(input.artifacts ?? []), input.contentHashes ?? [], input.evidenceKind ?? null,
      input.evidenceRef ?? null, input.evidenceUrl ?? null, input.fingerprint, input.generation ?? null,
    ]);
    if (rows[0]) return { inserted: true, row: rows[0] };
    const row = await postgresClient.queryOne('SELECT * FROM work_artifact_receipts WHERE task_id=$1 AND fingerprint=$2', [input.taskId, input.fingerprint]);
    return { inserted: false, row };
  }

  static listArtifactReceiptsByTask(taskId: string) {
    return postgresClient.query('SELECT * FROM work_artifact_receipts WHERE task_id=$1 ORDER BY created_at', [taskId]);
  }
  static findArtifactReceiptsByHash(hash: string) {
    return postgresClient.query('SELECT * FROM work_artifact_receipts WHERE $1=ANY(content_hashes) ORDER BY created_at', [hash]);
  }
  static findArtifactReceiptByComment(commentId: string) {
    return postgresClient.queryOne('SELECT * FROM work_artifact_receipts WHERE comment_id=$1 LIMIT 1', [commentId]);
  }
  static async loadArtifactEvidenceReference(commentId: string) {
    const receipt = await this.findArtifactReceiptByComment(commentId);
    if (!receipt) return null;
    const row = receipt as Record<string, unknown>;
    return { receipt, evidence: null, evidenceReference: { kind: row.evidence_kind ?? null, ref: row.evidence_ref ?? null, url: row.evidence_url ?? null } };
  }
  static attachArtifactReceiptComment(id: string, commentId: string) {
    return postgresClient.query('UPDATE work_artifact_receipts SET comment_id=$2 WHERE id=$1 RETURNING id', [id, commentId]);
  }

  static async claimGitHubPullRequestMirror(input: Record<string, unknown>) {
    return postgresClient.queryOne(`INSERT INTO github_pr_project_mirrors(owner,repository,pull_number,project_id,epic_id,parent_id)
      VALUES(lower($1),lower($2),$3,$4,$5,$6)
      ON CONFLICT(tenant_id,provider,owner,repository,pull_number) DO UPDATE SET project_id=excluded.project_id,
       epic_id=excluded.epic_id,parent_id=excluded.parent_id,last_seen_at=now(),updated_at=now(),archived_at=NULL RETURNING *`,
    [input.owner, input.repository, input.pullNumber, input.projectId, input.epicId, input.parentId ?? null]);
  }
  static listGitHubPullRequestMirrors(projectId: string, epicId: string) {
    return postgresClient.query(`SELECT owner,repository,pull_number,task_id,snapshot_fingerprint,remote_updated_at,remote_disposition,sync_generation
      FROM github_pr_project_mirrors WHERE project_id=$1 AND epic_id=$2 AND archived_at IS NULL ORDER BY owner,repository,pull_number`, [projectId, epicId]);
  }
  static async recordGitHubPullRequestSnapshot(input: Record<string, unknown>) {
    await postgresClient.query(`UPDATE github_pr_project_mirrors SET task_id=$4,snapshot_fingerprint=$5,remote_updated_at=$6,
      remote_disposition=$7,sync_generation=CASE WHEN snapshot_fingerprint IS DISTINCT FROM $5 THEN sync_generation+1 ELSE sync_generation END,
      last_seen_at=now(),last_error=NULL,updated_at=now() WHERE provider='github' AND owner=lower($1) AND repository=lower($2)
      AND pull_number=$3 AND archived_at IS NULL`, [input.owner,input.repository,input.pullNumber,input.taskId,input.fingerprint,input.remoteUpdatedAt,input.disposition]);
    return true;
  }
  static async recordGitHubPullRequestError(owner: string, repository: string, pullNumber: number, message: string) {
    await postgresClient.query(`UPDATE github_pr_project_mirrors SET last_error=$4,updated_at=now() WHERE provider='github'
      AND owner=lower($1) AND repository=lower($2) AND pull_number=$3 AND archived_at IS NULL`, [owner,repository,pullNumber,message.slice(0,2000)]);
    return true;
  }

  static upsertKnowledgeProjection(input: Record<string, unknown>) {
    return postgresClient.queryOne(`INSERT INTO projects_knowledge_projection(id,node_type,title,summary,detail,archived,merged_into,source,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(tenant_id,id) DO UPDATE SET node_type=excluded.node_type,title=excluded.title,
      summary=excluded.summary,detail=excluded.detail,archived=excluded.archived,merged_into=excluded.merged_into,source=excluded.source,updated_at=now() RETURNING *`,
    [input.id,input.node_type ?? 'entity',input.title,input.summary ?? '',input.detail ?? null,input.archived ?? false,input.merged_into ?? null,input.source ?? null]);
  }
  static async mergeKnowledgeProjection(sourceId: string, targetId: string) {
    await postgresClient.query('UPDATE projects_knowledge_projection SET merged_into=$2,archived=true,updated_at=now() WHERE id=$1', [sourceId,targetId]);
    await postgresClient.query('UPDATE work_item_knowledge_links SET knowledge_node_id=$2,updated_at=now() WHERE knowledge_node_id=$1 AND archived=false', [sourceId,targetId]);
    return true;
  }
}
