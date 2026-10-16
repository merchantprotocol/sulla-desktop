import express, { type NextFunction, type Response } from 'express';
import { agentPolicyAllows, type AgentAccessLevel } from '@sulla/vault-crypto';

import {
  authenticate,
  type AuthenticatedRequest,
  issueToken,
  makeLoginVerifier,
  verifyLoginHash,
} from './auth.js';
import { AccessDenied, getOrgRole, requireCollectionRight, requireOrgManager } from './rbac.js';
import { agentPolicyAllows, DEFAULT_AGENT_POLICY, type AgentAccessLevel } from '@sulla/vault-crypto';

import type { VaultConfig } from './config.js';
import type { Database } from './db.js';

const CONSOLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sulla Vault Console</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#6b7788;--paper:#f5f8fb;--card:#fff;--line:#dce4ec;--accent:#5096b3;--danger:#b91c1c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px system-ui,sans-serif}header{height:62px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 32px;gap:30px}header b{font:600 22px Georgia}nav{display:flex;gap:22px;color:var(--muted)}nav a{padding:22px 0;cursor:pointer}nav a.active{color:var(--ink);border-bottom:2px solid var(--accent)}main{max-width:1250px;margin:34px auto;padding:0 28px}.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.12em;font-size:11px}h1{font:600 34px Georgia;margin:4px 0}.lead{color:var(--muted)}.grid{display:grid;grid-template-columns:240px 1fr 270px;gap:18px;margin-top:24px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 10px 30px #2030400b}.collection{padding:13px;border-radius:10px;margin:4px 0}.collection.active{background:#eaf4f7;color:#23627a}.collection small{display:block;color:var(--muted);margin-top:5px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:13px 8px;border-top:1px solid var(--line)}th:not(:first-child),td:not(:first-child){text-align:center}.check{display:inline-grid;place-items:center;width:23px;height:23px;border-radius:7px;border:1px solid #aebdca}.check.on{background:var(--accent);border-color:var(--accent);color:white}.join{margin-top:24px;background:#eef7fa;border:1px solid #b6d9e4;border-radius:12px;padding:15px}.filters{display:flex;gap:8px;margin:20px 0}.chip,button{border:1px solid var(--line);background:white;border-radius:18px;padding:9px 14px;cursor:pointer}.chip.active,button.primary{background:var(--accent);color:white;border-color:var(--accent)}.audit{width:100%}.blocked{color:var(--danger);font-weight:600}.login{max-width:420px;margin:15vh auto}.login input{display:block;width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;margin:10px 0}</style></head><body><header><b>Sulla <span style="color:var(--accent)">Vault</span></b><nav><a class="active" data-page="collections">Collections</a><a data-page="audit">Audit log</a><a data-page="people">People</a></nav><span style="margin-left:auto;color:var(--muted)">Encrypted in your browser · <span id="status">locked</span></span></header><main id="app"><section data-view="collections"><p class="eyebrow">Org vault</p><h1>Shared collections</h1><p class="lead">Share passwords with a team. Choose who can see them, and whose agents can use them.</p><div class="grid"><div class="card"><b>Collections</b><div class="collection active">Engineering<small>31 items · 18 agent-usable</small></div><div class="collection">Cloud &amp; deploy keys<small>14 items · 14 agent-usable</small></div><div class="collection">Support desk<small>9 items · 9 agent-usable</small></div><div class="collection">Finance<small>6 items · people only</small></div></div><div class="card"><h2>Engineering</h2><p class="lead">31 items · 18 agents can use</p><table><thead><tr><th>Person or group</th><th>View</th><th>Agents use</th><th>Edit</th><th>Manage</th></tr></thead><tbody><tr><td>Engineers · group</td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check"></i></td><td><i class="check"></i></td></tr><tr><td>Jonathon Byrdziak · owner</td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td><td><i class="check on">✓</i></td></tr><tr><td>Sam Ortiz · member</td><td><i class="check on">✓</i></td><td><i class="check"></i></td><td><i class="check"></i></td><td><i class="check"></i></td></tr></tbody></table><div class="join"><b>Join password</b><p class="lead">Rotate the organization password. Only a verifier is stored on the server.</p><button class="primary">Rotate password</button></div></div><div class="card"><b>People</b><p>Jonathon Byrdziak<br><small>Owner · 2 desktops</small></p><p>Maria Chen<br><small>Admin · 1 desktop</small></p><p>Sam Ortiz<br><small>Member · view only</small></p></div></div></section><section data-view="audit" hidden><p class="eyebrow">Org vault</p><h1>Audit log</h1><p class="lead">Every person and agent action. Secret values are never written here.</p><div class="filters"><span class="chip active">Everyone</span><span class="chip">People</span><span class="chip">Agents</span><span class="chip">Blocked only</span><input placeholder="Filter by person, item or collection"></div><div class="card"><table class="audit"><thead><tr><th>Actor</th><th>Action</th><th>Collection / item</th><th>When</th><th>Result</th></tr></thead><tbody><tr><td>Maria Chen</td><td>Viewed item</td><td>Engineering / Deploy key</td><td>Today, 09:42</td><td>Allowed</td></tr><tr><td>Sulla agent · Sam Ortiz</td><td>Agent use</td><td>Engineering / Deploy key</td><td>Today, 09:38</td><td class="blocked">Blocked</td></tr></tbody></table><div class="join" style="background:#fff5f5;border-color:#efc2c2"><b>Blocked reason</b><p>Sam can only view, so Sam's agent was blocked too.</p></div></div></section><section data-view="people" hidden><p class="eyebrow">Organization</p><h1>People &amp; groups</h1><div class="card"><h2>Members</h2><p>Owner and admin actions wrap organization and collection keys client-side. The server stores ciphertext only.</p><button class="primary">Invite member</button> <button>New group</button></div></section></main><script>for(const a of document.querySelectorAll('nav a'))a.onclick=()=>{document.querySelectorAll('nav a').forEach(x=>x.classList.remove('active'));a.classList.add('active');document.querySelectorAll('[data-view]').forEach(x=>x.hidden=x.dataset.view!==a.dataset.page)};</script></body></html>`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new HttpError(400, `${ name } is required`);
  }
  return value;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${ name } is required`);
  }
  return value as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function userId(request: AuthenticatedRequest): string {
  if (!request.auth) {
    throw new HttpError(401, 'Authentication required');
  }
  return request.auth.userId;
}

async function authorizeItem(db: Database, actorId: string, itemId: string, right: 'view' | 'edit'): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT id, owner_user_id, collection_id, folder_id, item_type, ciphertext, encrypted_item_key,
            agent_wrapped_item_key, agent_policy, revision, created_at, updated_at
       FROM items WHERE id = $1 AND deleted_at IS NULL`,
    [itemId],
  );
  const item = result.rows[0];
  if (!item) {
    throw new HttpError(404, 'Item not found');
  }
  if (item.owner_user_id === actorId) {
    return item;
  }
  if (!item.collection_id) {
    throw new AccessDenied();
  }
  await requireCollectionRight(db, actorId, item.collection_id, right);
  return item;
}

async function authorizeItemFolder(
  db: Database,
  actorId: string,
  folderId: string,
  collectionId: string | null,
): Promise<void> {
  const folder = await db.query<{ owner_user_id: string | null; org_id: string | null }>(
    'SELECT owner_user_id, org_id FROM folders WHERE id = $1', [folderId],
  );
  const row = folder.rows[0];
  if (!row) throw new HttpError(400, 'Folder not found');
  if (row.owner_user_id === actorId && !collectionId) return;
  if (row.org_id && collectionId) {
    const collection = await db.query('SELECT 1 FROM collections WHERE id = $1 AND org_id = $2', [collectionId, row.org_id]);
    if (collection.rowCount) return;
  }
  throw new AccessDenied('Folder access denied');
}

export function createApp(db: Database, config: VaultConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.header('origin');
    const allowed = Boolean(origin && (origin.startsWith('chrome-extension://') || config.extensionOrigins.includes(origin)));
    if (allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin as string);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') { response.status(allowed ? 204 : 403).end(); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async(_request, response) => {
    await db.query('SELECT 1');
    response.json({ ok: true, mode: config.mode });
  });

  app.post('/v1/accounts', async(request, response) => {
    if (config.mode !== 'server') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const email = requiredString(request.body.email, 'email').trim().toLowerCase();
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const publicKey = requiredString(request.body.publicKey, 'publicKey');
    const encryptedPrivateKey = requiredObject(request.body.encryptedPrivateKey, 'encryptedPrivateKey');
    const encryptedUserKey = requiredObject(request.body.encryptedUserKey, 'encryptedUserKey');
    const kdf = requiredObject(request.body.kdf, 'kdf');
    const joinOrgId = typeof request.body.orgId === 'string' ? request.body.orgId : null;
    const joinPassword = typeof request.body.joinPassword === 'string' ? request.body.joinPassword : null;
    if ((joinOrgId && !joinPassword) || (!joinOrgId && joinPassword)) throw new HttpError(400, 'orgId and joinPassword must be supplied together');
    if (joinOrgId) {
      const org = await db.query<{ join_password_salt: Buffer; join_password_verifier: Buffer }>(
        'SELECT join_password_salt, join_password_verifier FROM orgs WHERE id = $1', [joinOrgId]);
      if (!org.rowCount || !org.rows[0].join_password_salt || !org.rows[0].join_password_verifier || !verifyLoginHash(joinPassword!, org.rows[0].join_password_salt, org.rows[0].join_password_verifier)) {
        response.status(403).json({ error: 'invalid_join_password' }); return;
      }
    }
    const { salt, verifier } = makeLoginVerifier(loginHash);
    const result = await db.query<{ id: string }>(
      `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email, salt, verifier, publicKey, encryptedPrivateKey, encryptedUserKey, kdf],
    );
    if (joinOrgId) {
      await db.query(`INSERT INTO org_members(org_id, user_id, role, wrapped_org_key) VALUES ($1, $2, 'member', $3)`,
        [joinOrgId, result.rows[0].id, requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey')]);
    }
    response.status(201).json({ id: result.rows[0].id });
  });

  app.get('/console', (_request, response) => response.type('html').send(CONSOLE_HTML));

  // Desktop bootstrap is deliberately limited to the local, single-user
  // mode. The client sends only derived login material and wrapped keys.
  app.post('/v1/desktop/bootstrap', async(request, response) => {
    if (config.mode !== 'desktop') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const publicKey = requiredString(request.body.publicKey, 'publicKey');
    const encryptedPrivateKey = requiredObject(request.body.encryptedPrivateKey, 'encryptedPrivateKey');
    const encryptedUserKey = requiredObject(request.body.encryptedUserKey, 'encryptedUserKey');
    const kdf = requiredObject(request.body.kdf, 'kdf');
    const existing = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    if (!existing.rowCount) {
      const { salt, verifier } = makeLoginVerifier(loginHash);
      await db.query(
        `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['desktop@local.sulla', salt, verifier, publicKey, encryptedPrivateKey, encryptedUserKey, kdf],
      );
    }
    response.status(existing.rowCount ? 200 : 201).json({ ok: true });
  });

  // The desktop client must use the persisted KDF parameters when an account
  // already exists. This endpoint intentionally exposes only public KDF data.
  app.get('/v1/desktop/bootstrap', async(_request, response) => {
    if (config.mode !== 'desktop') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const existing = await db.query<{ kdf: unknown }>('SELECT kdf FROM users WHERE disabled_at IS NULL LIMIT 1');
    if (!existing.rowCount) {
      response.status(404).json({ error: 'not_bootstrapped' });
      return;
    }
    response.json({ kdf: existing.rows[0].kdf });
  });

  app.post('/v1/session', async(request, response) => {
    const loginHash = requiredString(request.body.loginHash, 'loginHash');
    const email = config.mode === 'desktop' ? undefined : requiredString(request.body.email, 'email').trim().toLowerCase();
    const result = await db.query<{
      id:                    string;
      login_hash_salt:       Buffer;
      login_hash_verifier:   Buffer;
      public_key:            string;
      encrypted_private_key: unknown;
      encrypted_user_key:    unknown;
      kdf:                   unknown;
    }>(
      config.mode === 'desktop'
        ? `SELECT id, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf
             FROM users WHERE disabled_at IS NULL LIMIT 1`
        : `SELECT id, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf
             FROM users WHERE email = $1 AND disabled_at IS NULL`,
      email ? [email] : [],
    );
    const account = result.rows[0];
    if (!account || !verifyLoginHash(loginHash, account.login_hash_salt, account.login_hash_verifier)) {
      response.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    if (request.body.device && typeof request.body.device === 'object') {
      const device = request.body.device as Record<string, unknown>;
      const name = requiredString(device.name, 'device.name');
      await db.query(
        `INSERT INTO devices(user_id, name, public_key) VALUES ($1, $2, $3)`,
        [account.id, name, typeof device.publicKey === 'string' ? device.publicKey : null],
      );
    }
    response.json({
      token: issueToken(config, account.id),
      user:  {
        id:                  account.id,
        publicKey:           account.public_key,
        encryptedPrivateKey: account.encrypted_private_key,
        encryptedUserKey:    account.encrypted_user_key,
        kdf:                 account.kdf,
      },
    });
  });

  app.use('/v1', authenticate(config));

  app.get('/v1/items', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const result = await db.query(
      `SELECT DISTINCT i.id, i.owner_user_id, i.collection_id, i.folder_id, i.item_type, i.ciphertext,
              i.encrypted_item_key, i.agent_wrapped_item_key, i.revision, i.created_at, i.updated_at
         FROM items i
         LEFT JOIN collections c ON c.id = i.collection_id
         LEFT JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1
         LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
        WHERE i.deleted_at IS NULL
          AND (i.owner_user_id = $1 OR om.role IN ('owner', 'admin') OR (om.role = 'member' AND cm.can_view = true))
          AND ($2::uuid IS NULL OR i.collection_id = $2)
        ORDER BY i.updated_at DESC`,
      [actorId, typeof request.query.collectionId === 'string' ? request.query.collectionId : null],
    );
    response.json({ items: result.rows });
  });

  app.post('/v1/items', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const itemId = requiredString(request.body.id, 'id');
    const collectionId = typeof request.body.collectionId === 'string' ? request.body.collectionId : null;
    if (collectionId) {
      await requireCollectionRight(db, actorId, collectionId, 'edit');
    }
    const folderId = typeof request.body.folderId === 'string' ? request.body.folderId : null;
    if (folderId) await authorizeItemFolder(db, actorId, folderId, collectionId);
    const result = await db.query(
      `INSERT INTO items(id, owner_user_id, collection_id, folder_id, item_type, ciphertext, encrypted_item_key, agent_wrapped_item_key, agent_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, revision, created_at, updated_at`,
      [itemId, collectionId ? null : actorId, collectionId, folderId,
        requiredString(request.body.itemType, 'itemType'), requiredObject(request.body.ciphertext, 'ciphertext'),
        requiredObject(request.body.encryptedItemKey, 'encryptedItemKey'), request.body.agentWrappedItemKey ?? null,
        request.body.agentPolicy ? requiredObject(request.body.agentPolicy, 'agentPolicy') : DEFAULT_AGENT_POLICY],
    );
    response.status(201).json(result.rows[0]);
  });

  app.get('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    response.json(await authorizeItem(db, userId(request), requiredString(request.params.itemId, 'itemId'), 'view'));
  });

  app.patch('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const item = await authorizeItem(db, actorId, requiredString(request.params.itemId, 'itemId'), 'edit');
    const revision = Number(request.body.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, 'revision is required');
    }
    const updatesFolder = Object.hasOwn(request.body, 'folderId');
    if (updatesFolder && request.body.folderId !== null) {
      await authorizeItemFolder(db, actorId, requiredString(request.body.folderId, 'folderId'),
        typeof item.collection_id === 'string' ? item.collection_id : null);
    }
    const result = await db.query(
      `UPDATE items
          SET folder_id = CASE WHEN $1::boolean THEN $2 ELSE folder_id END, item_type = COALESCE($3, item_type),
              ciphertext = COALESCE($4, ciphertext), encrypted_item_key = COALESCE($5, encrypted_item_key),
              agent_wrapped_item_key = CASE WHEN $6::boolean THEN $7 ELSE agent_wrapped_item_key END,
              agent_policy = COALESCE($10, agent_policy),
              revision = revision + 1, updated_at = now()
        WHERE id = $8 AND revision = $9 AND deleted_at IS NULL
        RETURNING id, revision, updated_at`,
      [updatesFolder, request.body.folderId ?? null, request.body.itemType ?? null, request.body.ciphertext ?? null,
        request.body.encryptedItemKey ?? null, Object.hasOwn(request.body, 'agentWrappedItemKey'),
        request.body.agentWrappedItemKey ?? null, request.params.itemId, revision,
        request.body.agentPolicy ? requiredObject(request.body.agentPolicy, 'agentPolicy') : null],
    );
    if (!result.rowCount) {
      throw new HttpError(409, 'Item revision conflict');
    }
    response.json(result.rows[0]);
  });

  app.delete('/v1/items/:itemId', async(request: AuthenticatedRequest, response) => {
    await authorizeItem(db, userId(request), requiredString(request.params.itemId, 'itemId'), 'edit');
    const revision = Number(request.query.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, 'revision query parameter is required');
    }
    const result = await db.query(
      `UPDATE items SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE id = $1 AND revision = $2 AND deleted_at IS NULL RETURNING id, revision`,
      [request.params.itemId, revision],
    );
    if (!result.rowCount) {
      throw new HttpError(409, 'Item revision conflict');
    }
    response.json(result.rows[0]);
  });

  app.get('/v1/folders', async(request: AuthenticatedRequest, response) => {
    const result = await db.query('SELECT * FROM folders WHERE owner_user_id = $1 ORDER BY updated_at DESC', [userId(request)]);
    response.json({ folders: result.rows });
  });

  app.post('/v1/folders', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      'INSERT INTO folders(owner_user_id, encrypted_name) VALUES ($1, $2) RETURNING *',
      [userId(request), requiredObject(request.body.encryptedName, 'encryptedName')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.patch('/v1/folders/:folderId', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      `UPDATE folders SET encrypted_name = $1, revision = revision + 1, updated_at = now()
        WHERE id = $2 AND owner_user_id = $3 AND revision = $4 RETURNING *`,
      [requiredObject(request.body.encryptedName, 'encryptedName'), request.params.folderId, userId(request), Number(request.body.revision)],
    );
    if (!result.rowCount) throw new HttpError(409, 'Folder revision conflict');
    response.json(result.rows[0]);
  });

  app.delete('/v1/folders/:folderId', async(request: AuthenticatedRequest, response) => {
    const result = await db.query('DELETE FROM folders WHERE id = $1 AND owner_user_id = $2 RETURNING id', [request.params.folderId, userId(request)]);
    if (!result.rowCount) throw new HttpError(404, 'Folder not found');
    response.json(result.rows[0]);
  });

  app.post('/v1/orgs', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const org = await client.query<{ id: string }>(
        'INSERT INTO orgs(encrypted_name, created_by) VALUES ($1, $2) RETURNING id',
        [requiredObject(request.body.encryptedName, 'encryptedName'), actorId],
      );
      await client.query(
        `INSERT INTO org_members(org_id, user_id, role, wrapped_org_key) VALUES ($1, $2, 'owner', $3)`,
        [org.rows[0].id, actorId, requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey')],
      );
      await client.query('COMMIT');
      response.status(201).json(org.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/v1/orgs', async(request: AuthenticatedRequest, response) => {
    const result = await db.query(
      `SELECT o.id, o.encrypted_name, om.role, om.wrapped_org_key, o.created_at, o.updated_at
         FROM orgs o JOIN org_members om ON om.org_id = o.id
        WHERE om.user_id = $1 ORDER BY o.updated_at DESC`, [userId(request)],
    );
    response.json({ orgs: result.rows });
  });

  app.patch('/v1/orgs/:orgId', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const result = await db.query(
      'UPDATE orgs SET encrypted_name = $1, updated_at = now() WHERE id = $2 RETURNING id, encrypted_name, updated_at',
      [requiredObject(request.body.encryptedName, 'encryptedName'), orgId],
    );
    response.json(result.rows[0]);
  });

  app.get('/v1/orgs/:orgId/members', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(
      `SELECT om.user_id, om.role, om.wrapped_org_key, u.email, u.public_key
         FROM org_members om JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1 ORDER BY om.created_at`, [orgId],
    );
    response.json({ members: result.rows });
  });

  app.post('/v1/orgs/:orgId/members', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorRole = await requireOrgManager(db, userId(request), orgId);
    const memberId = requiredString(request.body.userId, 'userId');
    const role = requiredString(request.body.role, 'role');
    if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError(400, 'Invalid organization role');
    const current = await db.query<{ role: string }>(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, memberId],
    );
    if ((role === 'owner' || current.rows[0]?.role === 'owner') && actorRole !== 'owner') {
      throw new AccessDenied('Only owners can change owner membership');
    }
    if (current.rows[0]?.role === 'owner' && role !== 'owner') {
      const owners = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId],
      );
      if (owners.rows[0].count === '1') throw new HttpError(409, 'Cannot demote the last organization owner');
    }
    const result = await db.query(
      `INSERT INTO org_members(org_id, user_id, role, wrapped_org_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, wrapped_org_key = EXCLUDED.wrapped_org_key, updated_at = now()
       RETURNING org_id, user_id, role`,
      [orgId, memberId, role,
        requiredObject(request.body.wrappedOrgKey, 'wrappedOrgKey')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.delete('/v1/orgs/:orgId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorRole = await requireOrgManager(db, userId(request), orgId);
    const owners = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`,
      [orgId],
    );
    const target = await db.query<{ role: string }>(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, request.params.memberId],
    );
    if (target.rows[0]?.role === 'owner' && actorRole !== 'owner') {
      throw new AccessDenied('Only owners can remove owners');
    }
    if (target.rows[0]?.role === 'owner' && owners.rows[0].count === '1') {
      throw new HttpError(409, 'Cannot remove the last organization owner');
    }
    await db.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, request.params.memberId]);
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/collections', async(request: AuthenticatedRequest, response) => {
    await requireOrgManager(db, userId(request), requiredString(request.params.orgId, 'orgId'));
    const result = await db.query(
      `INSERT INTO collections(org_id, encrypted_name, wrapped_collection_key) VALUES ($1, $2, $3) RETURNING *`,
      [request.params.orgId, requiredObject(request.body.encryptedName, 'encryptedName'),
        requiredObject(request.body.wrappedCollectionKey, 'wrappedCollectionKey')],
    );
    response.status(201).json(result.rows[0]);
  });

  app.get('/v1/orgs/:orgId/collections', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    const actorId = userId(request);
    if (!await getOrgRole(db, actorId, orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(
      `SELECT c.id, c.encrypted_name, c.wrapped_collection_key, c.created_at, c.updated_at,
              cm.can_view, cm.can_use_by_agents, cm.can_edit, cm.can_manage
         FROM collections c
         JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1
         LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
        WHERE c.org_id = $2
          AND (om.role IN ('owner', 'admin') OR cm.can_view = true)
        ORDER BY c.updated_at DESC`, [actorId, orgId],
    );
    response.json({ collections: result.rows });
  });

  app.patch('/v1/collections/:collectionId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    const result = await db.query(
      `UPDATE collections SET encrypted_name = $1, wrapped_collection_key = COALESCE($2, wrapped_collection_key),
              updated_at = now()
        WHERE id = $3 RETURNING id, encrypted_name, wrapped_collection_key, updated_at`,
      [requiredObject(request.body.encryptedName, 'encryptedName'), request.body.wrappedCollectionKey ?? null, collectionId],
    );
    response.json(result.rows[0]);
  });

  app.get('/v1/collections/:collectionId/items', async(request: AuthenticatedRequest, response) => {
    await requireCollectionRight(db, userId(request), requiredString(request.params.collectionId, 'collectionId'), 'view');
    const result = await db.query(
      'SELECT * FROM items WHERE collection_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC',
      [request.params.collectionId],
    );
    response.json({ items: result.rows });
  });

  app.put('/v1/collections/:collectionId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    await requireCollectionRight(db, userId(request), requiredString(request.params.collectionId, 'collectionId'), 'manage');
    const view = Boolean(request.body.view);
    const useByAgents = Boolean(request.body.useByAgents);
    const edit = Boolean(request.body.edit);
    const manage = Boolean(request.body.manage);
    if (!view && (useByAgents || edit || manage)) {
      throw new HttpError(400, 'view is required for all other collection rights');
    }
    const result = await db.query(
      `INSERT INTO collection_members(collection_id, user_id, can_view, can_use_by_agents, can_edit, can_manage)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (collection_id, user_id) DO UPDATE
       SET can_view = EXCLUDED.can_view, can_use_by_agents = EXCLUDED.can_use_by_agents,
           can_edit = EXCLUDED.can_edit, can_manage = EXCLUDED.can_manage, updated_at = now()
       RETURNING *`,
      [request.params.collectionId, request.params.memberId, view, useByAgents, edit, manage],
    );
    response.json(result.rows[0]);
  });

  app.delete('/v1/collections/:collectionId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const collectionId = requiredString(request.params.collectionId, 'collectionId');
    await requireCollectionRight(db, userId(request), collectionId, 'manage');
    await db.query('DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2',
      [collectionId, request.params.memberId]);
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/join-password', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const { salt, verifier } = makeLoginVerifier(requiredString(request.body.password, 'password'));
    await db.query('UPDATE orgs SET join_password_salt = $1, join_password_verifier = $2, updated_at = now() WHERE id = $3', [salt, verifier, orgId]);
    response.status(204).end();
  });

  app.post('/v1/orgs/:orgId/join-password/rotate', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const { salt, verifier } = makeLoginVerifier(requiredString(request.body.password, 'password'));
    await db.query('UPDATE orgs SET join_password_salt = $1, join_password_verifier = $2, updated_at = now() WHERE id = $3', [salt, verifier, orgId]);
    response.status(204).end();
  });

  app.get('/v1/orgs/:orgId/groups', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const result = await db.query(`SELECT g.*, count(gm.user_id)::int AS member_count FROM org_groups g LEFT JOIN group_members gm ON gm.group_id = g.id WHERE g.org_id = $1 GROUP BY g.id ORDER BY g.created_at`, [orgId]);
    response.json({ groups: result.rows });
  });

  app.post('/v1/orgs/:orgId/groups', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    await requireOrgManager(db, userId(request), orgId);
    const result = await db.query('INSERT INTO org_groups(org_id, encrypted_name) VALUES ($1, $2) RETURNING *', [orgId, requiredObject(request.body.encryptedName, 'encryptedName')]);
    response.status(201).json(result.rows[0]);
  });

  app.put('/v1/groups/:groupId/members/:memberId', async(request: AuthenticatedRequest, response) => {
    const group = await db.query<{ org_id: string }>('SELECT org_id FROM org_groups WHERE id = $1', [request.params.groupId]);
    if (!group.rowCount) throw new HttpError(404, 'Group not found');
    await requireOrgManager(db, userId(request), group.rows[0].org_id);
    await db.query('INSERT INTO group_members(group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.params.groupId, request.params.memberId]);
    response.status(204).end();
  });

  app.put('/v1/collections/:collectionId/groups/:groupId', async(request: AuthenticatedRequest, response) => {
    await requireCollectionRight(db, userId(request), requiredString(request.params.collectionId, 'collectionId'), 'manage');
    const values = [Boolean(request.body.view), Boolean(request.body.useByAgents), Boolean(request.body.edit), Boolean(request.body.manage)];
    if (!values[0] && values.slice(1).some(Boolean)) throw new HttpError(400, 'view is required for all other collection rights');
    const result = await db.query(`INSERT INTO collection_group_members(collection_id, group_id, can_view, can_use_by_agents, can_edit, can_manage) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (collection_id,group_id) DO UPDATE SET can_view=$3,can_use_by_agents=$4,can_edit=$5,can_manage=$6 RETURNING *`, [request.params.collectionId, request.params.groupId, ...values]);
    response.json(result.rows[0]);
  });

  app.get('/v1/orgs/:orgId/audit', async(request: AuthenticatedRequest, response) => {
    const orgId = requiredString(request.params.orgId, 'orgId');
    if (!await getOrgRole(db, userId(request), orgId)) throw new AccessDenied('Organization access denied');
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200); const offset = Math.max(Number(request.query.offset) || 0, 0);
    const conditions = ['a.org_id = $1']; const params: unknown[] = [orgId];
    const add = (sql: string, value: unknown) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };
    if (typeof request.query.person === 'string') add('a.actor_user_id = ?::uuid', request.query.person);
    if (typeof request.query.collection === 'string') add('a.collection_id = ?::uuid', request.query.collection);
    if (typeof request.query.item === 'string') add('a.item_id = ?::uuid', request.query.item);
    if (typeof request.query.action === 'string') add('a.action = ?', request.query.action);
    if (request.query.blocked === 'true') conditions.push('a.blocked = true');
    if (typeof request.query.from === 'string') add('a.created_at >= ?::timestamptz', request.query.from);
    if (typeof request.query.to === 'string') add('a.created_at < ?::timestamptz', request.query.to);
    params.push(limit, offset);
    const result = await db.query(`SELECT a.id,a.actor_user_id,a.device_id,a.collection_id,a.item_id,a.action,a.pod_id,a.blocked,a.reason,a.created_at FROM audit_log a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    response.json({ events: result.rows, limit, offset });
  });

  app.get('/v1/sync', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request); const cursor = Number(request.query.cursor) || 0;
    const result = await db.query(`SELECT id,owner_user_id,collection_id,folder_id,item_type,ciphertext,encrypted_item_key,agent_wrapped_item_key,agent_policy,revision,deleted_at,created_at,updated_at FROM items i WHERE extract(epoch FROM i.updated_at) > $2 AND (i.owner_user_id=$1 OR EXISTS (SELECT 1 FROM collections c JOIN org_members om ON om.org_id=c.org_id AND om.user_id=$1 WHERE c.id=i.collection_id)) ORDER BY i.updated_at,id LIMIT 500`, [actorId, cursor]);
    response.json({ cursor: Math.floor(Date.now() / 1000), items: result.rows });
  });

  app.post('/v1/audit', async(request: AuthenticatedRequest, response) => {
    const actorId = userId(request);
    const itemId = typeof request.body.itemId === 'string' ? request.body.itemId : null;
    let collectionId = typeof request.body.collectionId === 'string' ? request.body.collectionId : null;
    let orgId = typeof request.body.orgId === 'string' ? request.body.orgId : null;
    const action = requiredString(request.body.action, 'action');
    let blocked = false;
    let reason: string | null = null;
    let item: Record<string, unknown> | undefined;
    if (itemId) {
      item = await authorizeItem(db, actorId, itemId, 'view');
      const itemCollectionId = typeof item.collection_id === 'string' ? item.collection_id : null;
      if (collectionId && itemCollectionId !== collectionId) {
        throw new HttpError(400, 'itemId does not belong to collectionId');
      }
      collectionId = itemCollectionId;
      if (!collectionId && orgId) throw new HttpError(400, 'A personal item cannot be audited under an organization');
    }
    if (collectionId) {
      try {
        await requireCollectionRight(db, actorId, collectionId, action === 'agent_credential_use' ? 'useByAgents' : 'view');
      } catch (error) {
        if (action !== 'agent_credential_use' || !(error instanceof AccessDenied)) throw error;
        blocked = true;
        reason = 'Your collection access does not allow agent use';
        await requireCollectionRight(db, actorId, collectionId, 'view');
      }
      const collection = await db.query<{ org_id: string }>('SELECT org_id FROM collections WHERE id = $1', [collectionId]);
      if (orgId && orgId !== collection.rows[0].org_id) {
        throw new HttpError(400, 'collectionId does not belong to orgId');
      }
      orgId = collection.rows[0].org_id;
    }
    if (action === 'agent_credential_use') {
      const agentId = requiredString(request.body.agentId, 'agentId');
      const level = (request.body.level === 'full' || request.body.level === 'autofill' ? request.body.level : 'metadata') as AgentAccessLevel;
      const policyResult = agentPolicyAllows((item?.agent_policy ?? null) as Parameters<typeof agentPolicyAllows>[0], { agentId, level, host: typeof request.body.host === 'string' ? request.body.host : undefined, onServer: true });
      if (!policyResult.allowed || (!collectionId && !item?.agent_wrapped_item_key)) {
        blocked = true;
        reason = !policyResult.allowed ? policyResult.reason ?? 'Agent policy denied this request' : 'Item is not enabled for agents';
      }
    }
    if (orgId && !collectionId) {
      const membership = await db.query(
        'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, actorId],
      );
      if (!membership.rowCount) throw new AccessDenied('Organization access denied');
    }
    if (request.body.deviceId) {
      const device = await db.query('SELECT 1 FROM devices WHERE id = $1 AND user_id = $2', [request.body.deviceId, actorId]);
      if (!device.rowCount) throw new AccessDenied('Device access denied');
    }
    const result = await db.query(
      `INSERT INTO audit_log(actor_user_id, device_id, org_id, collection_id, item_id, action, pod_id, metadata, blocked, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at, blocked, reason`,
      [actorId, request.body.deviceId ?? null, orgId, collectionId,
        itemId, action, request.body.podId ?? null, request.body.metadata ?? {}, blocked, reason],
    );
    if (blocked) { response.status(403).json({ error: 'agent_blocked', reason, auditId: result.rows[0].id }); return; }
    response.status(201).json(result.rows[0]);
  });

  app.use((error: unknown, _request: AuthenticatedRequest, response: Response, _next: NextFunction) => {
    if (error instanceof AccessDenied) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      response.status(409).json({ error: 'already_exists' });
      return;
    }
    console.error(error);
    response.status(500).json({ error: 'internal_error' });
  });

  return app;
}
