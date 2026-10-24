// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { randomUUID } from 'node:crypto';

import type { Request, Router } from 'express';

import { envelope } from '../envelope.js';
import { type RouteContext, httpError, param, requestedOrg, route, serviceJson, session } from './helpers.js';

const MESSAGE_ROLES = new Set(['user', 'assistant']);

/** The organization and owner every conversation query is pinned to. */
function scope(request: Request): [string, string, string] {
  const org = requestedOrg(request);
  const identity = session(request).identity;
  return [org, identity.issuer, identity.subject];
}

function title(value: unknown, fallback: string): string {
  return String(value ?? fallback).slice(0, 200);
}

export function registerChatRoutes(router: Router, { db, clients }: RouteContext): void {
  router.get('/chat/conversations', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const found = await db.query(
      `SELECT * FROM sulla_console.conversations
       WHERE organization_id=$1 AND issuer=$2 AND subject=$3 ORDER BY updated_at DESC`,
      [org, issuer, subject],
    );
    response.json(envelope(org, found.rows));
  }));

  router.post('/chat/conversations', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const found = await db.query(
      `INSERT INTO sulla_console.conversations(id,organization_id,issuer,subject,title)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [randomUUID(), org, issuer, subject, title(request.body?.title, 'New chat')],
    );
    response.status(201).json(envelope(org, found.rows[0]));
  }));

  router.patch('/chat/conversations/:conversationId', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const found = await db.query(
      `UPDATE sulla_console.conversations SET title=$1,updated_at=now()
       WHERE id=$2 AND organization_id=$3 AND issuer=$4 AND subject=$5 RETURNING *`,
      [title(request.body?.title, ''), param(request, 'conversationId'), org, issuer, subject],
    );
    if (!found.rowCount) throw httpError(404, 'conversation_not_found');
    response.json(envelope(org, found.rows[0]));
  }));

  router.delete('/chat/conversations/:conversationId', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const found = await db.query(
      `DELETE FROM sulla_console.conversations
       WHERE id=$1 AND organization_id=$2 AND issuer=$3 AND subject=$4`,
      [param(request, 'conversationId'), org, issuer, subject],
    );
    if (!found.rowCount) throw httpError(404, 'conversation_not_found');
    response.status(204).end();
  }));

  router.get('/chat/conversations/:conversationId/messages', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const found = await db.query(
      `SELECT m.* FROM sulla_console.messages m
       JOIN sulla_console.conversations c ON c.id=m.conversation_id
       WHERE c.id=$1 AND c.organization_id=$2 AND c.issuer=$3 AND c.subject=$4
       ORDER BY m.created_at`,
      [param(request, 'conversationId'), org, issuer, subject],
    );
    response.json(envelope(org, found.rows));
  }));

  router.post('/chat/conversations/:conversationId/messages', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const role = String(request.body?.role ?? 'user');
    if (!MESSAGE_ROLES.has(role)) throw httpError(400, 'invalid_role');
    const found = await db.query(
      `INSERT INTO sulla_console.messages(id,conversation_id,role,content)
       SELECT $1,c.id,$2,$3 FROM sulla_console.conversations c
       WHERE c.id=$4 AND c.organization_id=$5 AND c.issuer=$6 AND c.subject=$7
       RETURNING *`,
      [randomUUID(), role, String(request.body?.content ?? ''), param(request, 'conversationId'), org, issuer, subject],
    );
    if (!found.rowCount) throw httpError(404, 'conversation_not_found');
    response.status(201).json(envelope(org, found.rows[0]));
  }));

  router.post('/chat/conversations/:conversationId/run', route(async(request, response) => {
    const [org, issuer, subject] = scope(request);
    const owned = await db.query(
      'SELECT 1 FROM sulla_console.conversations WHERE id=$1 AND organization_id=$2 AND issuer=$3 AND subject=$4',
      [param(request, 'conversationId'), org, issuer, subject],
    );
    if (!owned.rowCount) throw httpError(404, 'conversation_not_found');
    response.status(202).json(await serviceJson(request, clients, 'agents', org, '/v1/runs', 'POST'));
  }));
}
