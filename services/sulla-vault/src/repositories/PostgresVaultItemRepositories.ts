// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, Queryable } from '../db.js';

export class PostgresVaultItemRepository {
  constructor(private readonly db: Database) {}

  findOwnedPersonalActive<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT * FROM items WHERE id=$1 AND owner_user_id=$2 AND collection_id IS NULL AND deleted_at IS NULL`, values);
  }

  listOwnedActiveByUpdated<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision,item_type,updated_at
         FROM items WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`, values);
  }

  listOwnedActiveForImport<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision FROM items WHERE deleted_at IS NULL`, values);
  }

  insertImportedItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy) VALUES ($1,$2,$3,$4,$5,$6)`, values);
  }

  findOwnedActiveForReveal<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision
         FROM items WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, values);
  }

  insertHumanItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING revision`, values);
  }

  updateHumanItemIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET item_type=$1,ciphertext=$2,encrypted_item_key=$3,agent_policy=$4,integration_ref=$5,
              revision=revision+1,updated_at=now()
        WHERE id=$6 AND owner_user_id=$7 AND revision=$8 AND deleted_at IS NULL RETURNING revision`, values);
  }

  findOwnedActiveCustomFields<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision
         FROM items WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, values);
  }

  softDeleteOwnedIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING id`, values);
  }

  listOwnedForBackup<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref,revision,created_at,updated_at FROM items WHERE owner_user_id=$1 AND deleted_at IS NULL', values);
  }

  insertBackupItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref,revision,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, values);
  }

  insertAgentItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
           VALUES ($1,$2,$3,$4,$5,$6,NULL) RETURNING revision`, values);
  }

  findOwnedActiveForAgentUpdate<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision FROM items
         WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, values);
  }

  updateOwnedCiphertextIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET ciphertext=$1,encrypted_item_key=$2,revision=revision+1,updated_at=now()
           WHERE id=$3 AND owner_user_id=$4 AND revision=$5 AND deleted_at IS NULL RETURNING revision`, values);
  }

  findOwnedIntegrationCredential<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision FROM items
         WHERE owner_user_id=$1 AND integration_ref=$2 AND deleted_at IS NULL LIMIT 1`, values);
  }

  updateCiphertextIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET ciphertext=$1,encrypted_item_key=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND revision=$4 RETURNING revision`, values);
  }

  insertAgentIntegrationItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING revision`, values);
  }

  listIntegrationMetadata<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision,integration_ref
         FROM items
        WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL
          AND split_part(integration_ref,'/',1)=$2
          AND ($3::text IS NULL OR split_part(integration_ref,'/',2)=$3)
        ORDER BY updated_at DESC`, values);
  }

  existsByIntegrationRefForActivation<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT 1 FROM items WHERE owner_user_id=$1 AND integration_ref=$2 AND collection_id IS NULL AND deleted_at IS NULL`, values);
  }

  existsByIntegrationRefForOAuth<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT 1 FROM items WHERE owner_user_id=$1 AND integration_ref=$2 AND collection_id IS NULL AND deleted_at IS NULL`, values);
  }

  insertOAuthAccount<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
           VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`, values);
  }

  findOwnedIntegrationAccount<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision FROM items
       WHERE owner_user_id=$1 AND integration_ref=$2 AND collection_id IS NULL AND deleted_at IS NULL LIMIT 1`, values);
  }

  updateIntegrationCiphertextIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET ciphertext=$1,encrypted_item_key=$2,revision=revision+1,updated_at=now()
           WHERE id=$3 AND revision=$4 AND deleted_at IS NULL`, values);
  }

  insertIntegrationAccount<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
           VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`, values);
  }

  softDeleteIntegrationAccounts<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now()
          WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL
            AND split_part(integration_ref,'/',1)=$2`, values);
  }

  insertSullaCloudAccount<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
         VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`, values);
  }

  softDeleteIntegrationFamilies<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now()
          WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL
            AND split_part(integration_ref,'/',1)=ANY($2::text[]) RETURNING id`, values);
  }

  findLegacyIntegrationItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>('SELECT id FROM items WHERE integration_ref=$1 AND owner_user_id=$2 AND deleted_at IS NULL', values);
  }

  insertMigratedLegacyItem<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
           VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`, values);
  }

  listAgentAccessiblePersonal<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision
         FROM items WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL
           AND agent_policy->>'mode'='agents'`, values);
  }

  findBrokerCredential<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT i.id,i.owner_user_id,i.collection_id,i.ciphertext,i.encrypted_item_key,i.agent_policy,i.revision,
              c.org_id,om.role,cm.can_use_by_agents,
              EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id=gm.group_id
                WHERE gm.user_id=$1 AND cgm.collection_id=i.collection_id AND cgm.can_use_by_agents=true) AS group_can_use_by_agents
         FROM items i LEFT JOIN collections c ON c.id=i.collection_id
         LEFT JOIN org_members om ON om.org_id=c.org_id AND om.user_id=$1 AND om.status='confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id=i.collection_id AND cm.user_id=$1
        WHERE i.deleted_at IS NULL AND (($2::uuid IS NOT NULL AND i.id=$2) OR ($3::text IS NOT NULL AND i.integration_ref=$3)) LIMIT 1`, values);
  }

  updateOAuthCiphertextIfRevision<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`UPDATE items SET ciphertext=$1,encrypted_item_key=$2,agent_wrapped_item_key=NULL,
              revision=revision+1,updated_at=now()
        WHERE id=$3 AND revision=$4 AND deleted_at IS NULL RETURNING revision`, values);
  }
}

export class PostgresVaultAuditLogRepository {
  constructor(private readonly db: Database) {}

  listOwnedActivity<T extends QueryResultRow = QueryResultRow>(values: unknown[], itemFilter: string, client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT a.id,a.item_id,a.action,a.pod_id,a.metadata,a.blocked,a.reason,a.created_at
         FROM audit_log a JOIN items i ON i.id=a.item_id
        WHERE i.owner_user_id=$1 ${ itemFilter }
        ORDER BY a.created_at DESC LIMIT 100`, values);
  }

  recordAgentCreated<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,pod_id,metadata,blocked)
           VALUES ($1,$2,'agent_vault_item_created',$3,$4,false)`, values);
  }

  wasCreatedByAgentForUpdate<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT 1 FROM audit_log WHERE item_id=$1 AND action='agent_vault_item_created' AND metadata->>'agentId'=$2 LIMIT 1`, values);
  }

  recordAgentUpdated<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,pod_id,metadata,blocked)
           VALUES ($1,$2,'agent_vault_item_updated',$3,$4,false)`, values);
  }

  wasCreatedByAgentForIntegration<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT 1 FROM audit_log WHERE item_id=$1 AND action='agent_vault_item_created' AND metadata->>'agentId'=$2 LIMIT 1`, values);
  }

  recordIntegrationAgentUpdated<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,pod_id,metadata,blocked) VALUES ($1,$2,'agent_vault_item_updated',$3,$4,false)`, values);
  }

  recordIntegrationAgentCreated<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,pod_id,metadata,blocked) VALUES ($1,$2,'agent_vault_item_created',$3,$4,false)`, values);
  }

  recordHumanAction<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,metadata,blocked)
       VALUES ($1,$2,$3,'{}'::jsonb,false)`, values);
  }

  recordOutboundRequest<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,org_id,collection_id,item_id,action,pod_id,metadata,blocked,reason)
       VALUES ($1,$2,$3,$4,'vault_outbound_request',$5,$6,$7,$8)`, values);
  }

  recordOutboundDenial<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO audit_log(actor_user_id,item_id,action,pod_id,metadata,blocked,reason)
       VALUES ($1,NULL,'vault_outbound_request',$2,$3,true,$4)`, values);
  }
}
