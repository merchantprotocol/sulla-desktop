#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
docker=(/usr/bin/docker -H unix:///var/run/docker.sock)
fixture_id="$$-$(date +%s)"
network="sulla-projects-acceptance-net-$fixture_id"
database="sulla-projects-acceptance-db-$fixture_id"
api="sulla-projects-acceptance-api-$fixture_id"
migration_api="sulla-projects-acceptance-migration-api-$fixture_id"
image="sulla-projects-synthetic:${fixture_id}"

cleanup() {
  local result=$?
  if [[ $result -ne 0 ]]; then
    "${docker[@]}" logs --tail 40 "$api" 2>/dev/null || true
    "${docker[@]}" logs --tail 40 "$migration_api" 2>/dev/null || true
  fi
  "${docker[@]}" rm -fv "$api" "$migration_api" "$database" >/dev/null 2>&1 || true
  "${docker[@]}" network rm "$network" >/dev/null 2>&1 || true
  "${docker[@]}" image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

~/sulla/bin/sulla-heavy ./node_modules/.bin/tsc -p services/sulla-projects/tsconfig.json --noEmit
~/sulla/bin/sulla-heavy "${docker[@]}" build -f services/sulla-projects/Dockerfile -t "$image" .
"${docker[@]}" run --rm -v "$PWD/services/sulla-projects/test:/app/test:ro" "$image" node --test test/domain.test.mjs
"${docker[@]}" network create "$network" >/dev/null
"${docker[@]}" run -d --name "$database" --network "$network" \
  -e POSTGRES_USER=sulla -e POSTGRES_PASSWORD=synthetic-admin-password \
  -e POSTGRES_DB=sulla postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  "${docker[@]}" exec "$database" pg_isready -U sulla -d sulla >/dev/null 2>&1 && break
  sleep 1
done
"${docker[@]}" exec "$database" pg_isready -U sulla -d sulla >/dev/null

common_env=(
  -e SULLA_PROJECTS_PORT=8793
  -e SULLA_PROJECTS_ADMIN_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla
  -e SULLA_PROJECTS_MIGRATION_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla_projects
  -e SULLA_PROJECTS_DATABASE_URL=postgresql://sulla_projects_service:synthetic-runtime-password@"$database":5432/sulla_projects
  -e SULLA_PROJECTS_DATABASE_PASSWORD=synthetic-runtime-password
  -e SULLA_PROJECTS_DATABASE_NAME=sulla_projects
  -e SULLA_PROJECTS_DATABASE_OWNER=sulla
  -e SULLA_PROJECTS_DATABASE_ROLE=sulla_projects_service
  -e SULLA_PROJECTS_TENANT_ID=desktop-user
  -e SULLA_PROJECTS_USER_ID=desktop-user
)

"${docker[@]}" run -d --name "$api" --network "$network" -p 127.0.0.1:38793:8793 \
  "${common_env[@]}" -e SULLA_PROJECTS_MODE=desktop -e SULLA_PROJECTS_LOCAL_TOKEN=synthetic-local-token \
  -e SULLA_PROJECTS_HUMAN_TOKEN=synthetic-human-token -e SULLA_PROJECTS_AUTO_ARCHIVE_HOURS=24 "$image" >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:38793/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:38793/healthz >/dev/null

node <<'NODE'
async function rpc(token, operation, args = [], actor = 'sulla', source = 'system') {
  const response = await fetch('http://127.0.0.1:38793/v1/rpc', { method: 'POST', headers: {
    authorization: `Bearer ${ token }`, 'content-type': 'application/json',
    'x-sulla-projects-actor': actor, 'x-sulla-projects-source': source,
  }, body: JSON.stringify({ operation, args }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${ operation }:${ response.status }:${ JSON.stringify(body) }`);
  return body.result;
}
const local = 'synthetic-local-token';
const project = await rpc(local, 'createProject', [{ id: 'project-smoke', slug: 'smoke', title: 'Smoke', source: 'synthetic' }]);
if (project.source !== 'synthetic') throw new Error('source provenance lost');
await rpc(local, 'createEpic', [{ id: 'epic-smoke', project_id: project.id, title: 'Epic' }]);
await rpc(local, 'createTask', [{ id: 'task-parent', project_id: project.id, epic_id: 'epic-smoke', title: 'Parent' }]);
await rpc(local, 'createTask', [{ id: 'task-child', project_id: project.id, epic_id: 'epic-smoke', parent_id: 'task-parent', title: 'Child' }]);
await rpc(local, 'saveView', [{ id: 'view-smoke', project_id: project.id, name: 'Board', view_type: 'board', is_default: true }]);
const forged = await rpc(local, 'addComment', [{ id: 'comment-forged', task_id: 'task-parent', body: 'service', author: 'human' }], 'human', 'ipc');
if (forged.author === 'human') throw new Error('service token forged human');
const real = await rpc('synthetic-human-token', 'addComment', [{ id: 'comment-human', task_id: 'task-parent', body: 'human' }]);
if (real.author !== 'human') throw new Error('human capability lost author');
const events = await rpc(local, 'claimDomainEvents', [{ consumerId: 'smoke', eventTypes: ['projects.human_comment_added'] }]);
if (events.length !== 1) throw new Error('human event missing');
if (await rpc(local, 'completeDomainEvents', [[events[0].id], 'smoke']) !== 1) throw new Error('event ack failed');
await rpc(local, 'upsertKnowledgeProjection', [{ id: 'knowledge-source', title: 'Source' }]);
await rpc(local, 'upsertKnowledgeProjection', [{ id: 'knowledge-target', title: 'Target' }]);
for (const knowledgeNodeId of ['knowledge-source', 'knowledge-target']) {
  await rpc(local, 'linkKnowledge', [{ itemKind: 'task', itemId: 'task-parent', knowledgeNodeId }]);
}
await rpc(local, 'linkKnowledge', [{ itemKind: 'task', itemId: 'task-child', knowledgeNodeId: 'knowledge-source' }]);
await rpc(local, 'mergeKnowledgeProjection', ['knowledge-source', 'knowledge-target']);
await rpc(local, 'mergeKnowledgeProjection', ['knowledge-source', 'knowledge-target']);
const links = await rpc(local, 'listWorkForKnowledge', ['knowledge-target']);
if (links.length !== 2 || new Set(links.map(link => link.task_id)).size !== 2) {
  throw new Error('Knowledge merge lost links or duplicated overlapping links');
}
NODE

# A crashed consumer must not strand a processing event forever.
"${docker[@]}" exec "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla_projects -c "UPDATE work_project_domain_events SET status='processing',lease_owner='crashed-consumer',leased_until=now()-interval '1 minute',completed_at=NULL WHERE event_type='projects.human_comment_added'" >/dev/null
node <<'NODE'
const rpc = async (operation,args) => {
  const response = await fetch('http://127.0.0.1:38793/v1/rpc', {method:'POST',headers:{authorization:'Bearer synthetic-local-token','content-type':'application/json'},body:JSON.stringify({operation,args})});
  if (!response.ok) throw new Error('event recovery RPC failed');
  return (await response.json()).result;
};
const events = await rpc('claimDomainEvents',[{consumerId:'replacement-consumer',eventTypes:['projects.human_comment_added']}]);
if(events.length!==1) throw new Error('crashed consumer stranded event');
if(await rpc('completeDomainEvents',[[events[0].id],'crashed-consumer'])!==0) throw new Error('stale consumer completed event');
if(await rpc('completeDomainEvents',[[events[0].id],'replacement-consumer'])!==1) throw new Error('replacement consumer could not acknowledge');
NODE

"${docker[@]}" rm -f "$api" >/dev/null
"${docker[@]}" run -d --name "$api" --network "$network" -p 127.0.0.1:38793:8793 \
  "${common_env[@]}" -e SULLA_PROJECTS_MODE=server -e SULLA_PROJECTS_JWT_SECRET=synthetic-jwt-secret-for-smoke-only \
  -e SULLA_PROJECTS_JWT_ISSUER=synthetic-issuer -e SULLA_PROJECTS_JWT_AUDIENCE=sulla-projects "$image" >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:38793/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:38793/healthz >/dev/null

node <<'NODE'
const jwt = (await import('jsonwebtoken')).default;
const sign = (tenant, role, subject) => jwt.sign({ org_id: tenant, projects_role: role }, 'synthetic-jwt-secret-for-smoke-only', {
  algorithm: 'HS256', issuer: 'synthetic-issuer', audience: 'sulla-projects', subject, expiresIn: '5m',
});
const editor = sign('tenant-a', 'editor', 'editor-a');
const viewer = sign('tenant-a', 'viewer', 'viewer-a');
const tenantB = sign('tenant-b', 'viewer', 'viewer-b');
async function post(path, token, body) {
  const response = await fetch(`http://127.0.0.1:38793${ path }`, { method: 'POST', headers: {
    authorization: `Bearer ${ token }`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const rpc = (token, operation, args = []) => post('/v1/rpc', token, { operation, args });
if ((await rpc('invalid-token', 'listProjects')).status !== 401) throw new Error('invalid JWT was not rejected as unauthenticated');
let result = await rpc(editor, 'createProject', [{ id: 'tenant-a-project', slug: 'tenant-a', title: 'Tenant A' }]);
if (result.status !== 200) throw new Error('fresh tenant create failed');
if ((await rpc(viewer, 'createProject', [{ title: 'Forbidden' }])).status !== 403) throw new Error('viewer mutated');
if ((await rpc(tenantB, 'getProject', ['tenant-a-project'])).body.result !== null) throw new Error('RLS isolation failed');
if ((await rpc(viewer, 'resolveEffectiveLanes', ['tenant-a-project'])).body.result.length < 5) throw new Error('tenant bootstrap failed');
if ((await rpc(editor, 'createProject', [{ id: 'must-rollback', slug: 'must-rollback', title: 'Rollback', pipeline_template_id: 'missing' }])).status !== 500) throw new Error('template failure missing');
if ((await rpc(viewer, 'getProject', ['must-rollback'])).body.result !== null) throw new Error('partial project persisted');
await rpc(editor, 'createEpic', [{ id: 'cycle-epic', project_id: 'tenant-a-project', title: 'Cycle' }]);
await rpc(editor, 'createTask', [{ id: 'cycle-a', project_id: 'tenant-a-project', epic_id: 'cycle-epic', title: 'A' }]);
await rpc(editor, 'createTask', [{ id: 'cycle-b', project_id: 'tenant-a-project', epic_id: 'cycle-epic', title: 'B' }]);
await rpc(editor, 'createDependency', [{ dependentTaskId: 'cycle-a', dependsOnTaskId: 'cycle-b' }]);
if ((await rpc(editor, 'createDependency', [{ dependentTaskId: 'cycle-b', dependsOnTaskId: 'cycle-a' }])).status !== 500) throw new Error('cycle accepted');
if ((await rpc(viewer, 'listDependencies', ['cycle-b'])).body.result.length) throw new Error('partial cycle persisted');
const leaseAuth = sign('tenant-a', 'editor', 'lease-subject');
let claim = await post('/v1/claims/claim', leaseAuth, { externalRef: 'parent-job', assignees: { 'cycle-a': 'parent-agent' } });
const parent = claim.body.result.leases[0];
claim = await post('/v1/claims/claim', leaseAuth, { externalRef: 'child-job', assignees: { 'cycle-a': 'child-agent' }, inheritedClaims: { 'cycle-a': parent.token } });
const child = claim.body.result.leases[0];
if (!child || child.token === parent.token) throw new Error('lease handoff did not rotate');
if ((await post('/v1/claims/renew', leaseAuth, { externalRef: 'parent-job', leases: [{ taskId: 'cycle-a', token: parent.token }] })).status !== 409) throw new Error('parent lease remained live');
if ((await post('/v1/claims/renew', leaseAuth, { externalRef: 'child-job', leases: [{ taskId: 'cycle-a', token: child.token }] })).status !== 200) throw new Error('child lease invalid');
NODE

"${docker[@]}" exec "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla_projects -c "UPDATE work_task_claims SET expires_at=now()-interval '1 minute' WHERE tenant_id='tenant-a' AND task_id='cycle-a'" >/dev/null
"${docker[@]}" restart "$api" >/dev/null
for _ in $(seq 1 30); do
  recovered=$("${docker[@]}" exec "$database" psql -At -U sulla -d sulla_projects -c "SELECT count(*) FROM work_task_claims WHERE tenant_id='tenant-a' AND task_id='cycle-a' AND released_at IS NULL")
  [[ "$recovered" == 0 ]] && break
  sleep 1
done
[[ "$recovered" == 0 ]] || { echo 'idle claim recovery failed' >&2; exit 1; }
restored=$("${docker[@]}" exec "$database" psql -At -U sulla -d sulla_projects -c "SELECT assignee IS NULL FROM work_tasks WHERE tenant_id='tenant-a' AND id='cycle-a'")
[[ "$restored" == t ]] || { echo 'expired claim did not restore assignee' >&2; exit 1; }

"${docker[@]}" exec -i "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla < services/sulla-projects/scripts/legacy-fixture.sql >/dev/null
"${docker[@]}" run -d --name "$migration_api" --network "$network" -p 127.0.0.1:38795:8793 \
  -e SULLA_PROJECTS_PORT=8793 -e SULLA_PROJECTS_MODE=desktop -e SULLA_PROJECTS_LOCAL_TOKEN=synthetic-migration-token \
  -e SULLA_PROJECTS_ADMIN_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla \
  -e SULLA_PROJECTS_MIGRATION_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla_projects_migration \
  -e SULLA_PROJECTS_DATABASE_URL=postgresql://sulla_projects_service:synthetic-runtime-password@"$database":5432/sulla_projects_migration \
  -e SULLA_PROJECTS_DATABASE_PASSWORD=synthetic-runtime-password -e SULLA_PROJECTS_DATABASE_NAME=sulla_projects_migration \
  -e SULLA_PROJECTS_DATABASE_OWNER=sulla -e SULLA_PROJECTS_DATABASE_ROLE=sulla_projects_service \
  -e SULLA_PROJECTS_LEGACY_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla \
  -e SULLA_PROJECTS_TENANT_ID=migration-tenant -e SULLA_PROJECTS_USER_ID=migration-user "$image" >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:38795/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:38795/healthz >/dev/null
set +e
fence_output=$("${docker[@]}" exec "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla -c "UPDATE work_projects SET title='competing' WHERE id='legacy-project'" 2>&1)
fence_status=$?
set -e
if [[ $fence_status -eq 0 ]] || ! grep -Fq 'legacy write rejected' <<<"$fence_output"; then
  echo 'legacy write fence failed' >&2
  exit 1
fi
# Imported history and sequence-backed rows must survive the cutover intact.
"${docker[@]}" exec -i "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla_projects_migration >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM work_project_domain_events WHERE tenant_id='migration-tenant' AND id='legacy-event' AND generation=3 AND payload='{"synthetic":true}'::jsonb) THEN
    RAISE EXCEPTION 'legacy event history lost';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM work_task_artifact_custody WHERE tenant_id='migration-tenant' AND id='legacy-custody' AND created_by='synthetic-fixture') THEN
    RAISE EXCEPTION 'legacy custody history lost';
  END IF;
  IF nextval(pg_get_serial_sequence('work_schedule_audit','id')) <= 41 THEN
    RAISE EXCEPTION 'schedule audit identity sequence not advanced';
  END IF;
  IF nextval(pg_get_serial_sequence('github_pr_project_mirrors','id')) <= 51 THEN
    RAISE EXCEPTION 'mirror identity sequence not advanced';
  END IF;
END $$;
SQL
"${docker[@]}" exec "$database" psql -v ON_ERROR_STOP=1 -U sulla -d sulla_projects_migration -c "UPDATE work_projects SET title='Edited after import' WHERE id='legacy-project'" >/dev/null
"${docker[@]}" restart "$migration_api" >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:38795/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:38795/healthz >/dev/null
# Service-first fresh install: no legacy tables exist during the one-time
# import. Desktop creates them later and reapplies the persisted fence before
# enabling callers, without restarting the already-running Projects service.
"${docker[@]}" rm -fv "$migration_api" >/dev/null
"${docker[@]}" exec "$database" createdb -U sulla fresh_legacy
"${docker[@]}" run -d --name "$migration_api" --network "$network" -p 127.0.0.1:38795:8793 \
  -e SULLA_PROJECTS_PORT=8793 -e SULLA_PROJECTS_MODE=desktop -e SULLA_PROJECTS_LOCAL_TOKEN=synthetic-fresh-token \
  -e SULLA_PROJECTS_ADMIN_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla \
  -e SULLA_PROJECTS_MIGRATION_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/sulla_projects_fresh \
  -e SULLA_PROJECTS_DATABASE_URL=postgresql://sulla_projects_service:synthetic-runtime-password@"$database":5432/sulla_projects_fresh \
  -e SULLA_PROJECTS_DATABASE_PASSWORD=synthetic-runtime-password -e SULLA_PROJECTS_DATABASE_NAME=sulla_projects_fresh \
  -e SULLA_PROJECTS_DATABASE_OWNER=sulla -e SULLA_PROJECTS_DATABASE_ROLE=sulla_projects_service \
  -e SULLA_PROJECTS_LEGACY_DATABASE_URL=postgresql://sulla:synthetic-admin-password@"$database":5432/fresh_legacy \
  -e SULLA_PROJECTS_TENANT_ID=fresh-tenant -e SULLA_PROJECTS_USER_ID=fresh-user "$image" >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:38795/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:38795/healthz >/dev/null
"${docker[@]}" exec -i "$database" psql -v ON_ERROR_STOP=1 -U sulla -d fresh_legacy >/dev/null <<'SQL'
CREATE TABLE work_projects(id text PRIMARY KEY, title text NOT NULL);
CREATE TABLE workflow_executions(execution_id text PRIMARY KEY, scope_task_id text, scope_generation integer, updated_at timestamptz);
CREATE TABLE work_task_planning_runs(execution_id text, task_id text, attempt integer);
CREATE TABLE work_lane_entry_automations(id text);
CREATE TABLE work_task_dispatches(id text);
CREATE TABLE work_task_waits(id text);
CREATE TABLE agent_jobs(id text);
CREATE TABLE knowledge_nodes(id text);
CREATE TABLE work_routine_slots(id text);
CREATE TABLE work_file_claims(id text);
INSERT INTO workflow_executions VALUES ('legacy-planning', NULL, NULL, now());
INSERT INTO work_task_planning_runs VALUES ('legacy-planning', 'legacy-task', 2);
SELECT public.sulla_projects_apply_legacy_write_fence();
DO $$
DECLARE history_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workflow_executions WHERE execution_id='legacy-planning' AND scope_task_id='legacy-task' AND scope_generation=2) THEN
    RAISE EXCEPTION 'legacy workflow scope not preserved';
  END IF;
  FOREACH history_table IN ARRAY ARRAY['work_task_planning_runs','work_lane_entry_automations','work_task_dispatches','work_task_waits'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', history_table);
    BEGIN
      EXECUTE format('DELETE FROM %I', history_table);
      RAISE EXCEPTION 'retired history remained writable: %', history_table;
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='sulla_projects_container_write_fence' AND c.relname=ANY(ARRAY['agent_jobs','workflow_executions','knowledge_nodes','work_routine_slots','work_file_claims'])) THEN
    RAISE EXCEPTION 'non-Projects owner was fenced';
  END IF;
END $$;
DO $$
BEGIN
  BEGIN
    INSERT INTO work_projects VALUES('forbidden', 'Competing owner');
    RAISE EXCEPTION 'late legacy table remained writable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $$;
SQL
echo 'Sulla Projects synthetic acceptance passed.'
