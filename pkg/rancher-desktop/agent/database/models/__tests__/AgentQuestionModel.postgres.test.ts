/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createAgentQuestions } from '../../migrations/0078_create_agent_questions';
import { AgentQuestionModel } from '../AgentQuestionModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

const QUESTIONS = [{
  question: 'Deploy to prod?',
  options:  [{ label: 'Approve' }, { label: 'Deny' }],
}];

function newId() {
  return `quest_${ Date.now() }_${ randomUUID().slice(0, 8) }`;
}

describeWithPostgres('AgentQuestionModel on a migrated PostgreSQL database', () => {
  let pool: Pool;

  beforeAll(async() => {
    pool = new Pool({ connectionString, max: 8 });
    await pool.query('DROP TABLE IF EXISTS agent_questions CASCADE');
    await pool.query(createAgentQuestions);

    jest.spyOn(postgresClient, 'transaction').mockImplementation(async(callback: any) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }, 30_000);

  beforeEach(async() => {
    await pool.query('TRUNCATE agent_questions');
  });

  afterAll(async() => {
    jest.restoreAllMocks();
    await pool?.end();
  });

  describe('record() dedup identity', () => {
    it('returns one canonical id for concurrent identical asks and never an undefined row', async() => {
      const conversationId = `conv-${ randomUUID() }`;
      const attempts = await Promise.all(Array.from({ length: 8 }, () => AgentQuestionModel.record({
        id: newId(), conversationId, questions: QUESTIONS,
      })));

      // Every caller gets a real row (no undefined between conflict and read-back)…
      for (const attempt of attempts) {
        expect(attempt.question).toBeDefined();
        expect(attempt.question.status).toBe('pending');
      }
      // …exactly one insert won…
      expect(attempts.filter(a => a.created)).toHaveLength(1);
      // …and every caller converged on the winner's id: the canonical identity
      // callers park/emit under is the id that actually exists.
      const winnerId = attempts.find(a => a.created)!.question.id;
      expect(new Set(attempts.map(a => a.question.id))).toEqual(new Set([winnerId]));

      const stored = await pool.query('SELECT id, status FROM agent_questions');
      expect(stored.rows).toEqual([{ id: winnerId, status: 'pending' }]);
    });

    it('deduplicates only while pending — a settled question can be re-asked', async() => {
      const conversationId = `conv-${ randomUUID() }`;
      const first = await AgentQuestionModel.record({ id: newId(), conversationId, questions: QUESTIONS });
      expect(first.created).toBe(true);

      const dup = await AgentQuestionModel.record({ id: newId(), conversationId, questions: QUESTIONS });
      expect(dup.created).toBe(false);
      expect(dup.question.id).toBe(first.question.id);

      await AgentQuestionModel.answer(first.question.id, {
        answers: [{ question: QUESTIONS[0].question, selected: ['Approve'] }],
      });

      const reAsk = await AgentQuestionModel.record({ id: newId(), conversationId, questions: QUESTIONS });
      expect(reAsk.created).toBe(true);
      expect(reAsk.question.id).not.toBe(first.question.id);
    });

    it('does not deduplicate across profiles', async() => {
      const conversationId = `conv-${ randomUUID() }`;
      const a = await AgentQuestionModel.record({
        id: newId(), conversationId, questions: QUESTIONS, profileId: 'alice',
      });
      const b = await AgentQuestionModel.record({
        id: newId(), conversationId, questions: QUESTIONS, profileId: 'bob',
      });
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(a.question.id).not.toBe(b.question.id);
    });
  });

  describe('answer() atomic claim', () => {
    it('lets exactly one of many concurrent answers claim the row', async() => {
      const { question } = await AgentQuestionModel.record({
        id: newId(), conversationId: `conv-${ randomUUID() }`, questions: QUESTIONS,
      });

      const submits = await Promise.all(Array.from({ length: 6 }, (_, i) => AgentQuestionModel.answer(question.id, {
        answers:    [{ question: QUESTIONS[0].question, selected: [i % 2 ? 'Approve' : 'Deny'] }],
        answeredBy: `answerer-${ i }`,
      })));

      const winners = submits.filter(s => s.ok);
      expect(winners).toHaveLength(1);
      // Losers still see the (settled) row — fail-closed, not an error.
      for (const loser of submits.filter(s => !s.ok)) {
        expect(loser.question?.status).toBe('answered');
      }

      const stored = await pool.query('SELECT status, answered_by FROM agent_questions WHERE id = $1', [question.id]);
      expect(stored.rows[0].status).toBe('answered');
      expect(stored.rows[0].answered_by).toBe(winners[0].question!.answered_by);
    });

    it('refuses to re-claim an expired question', async() => {
      const { question } = await AgentQuestionModel.record({
        id: newId(), conversationId: `conv-${ randomUUID() }`, questions: QUESTIONS,
      });
      expect(await AgentQuestionModel.expire(question.id)).toBe(true);

      const late = await AgentQuestionModel.answer(question.id, {
        answers: [{ question: QUESTIONS[0].question, selected: ['Approve'] }],
      });
      expect(late.ok).toBe(false);
      expect(late.question?.status).toBe('expired');
    });
  });

  describe('profile scoping (authorization boundary)', () => {
    it('hides other profiles from list/get and rejects out-of-scope answers without state change', async() => {
      const conversationId = `conv-${ randomUUID() }`;
      const { question } = await AgentQuestionModel.record({
        id: newId(), conversationId, questions: QUESTIONS, profileId: 'alice',
      });

      // Reads: invisible outside the owning scope.
      expect(await AgentQuestionModel.listPending({ profileId: 'bob' })).toHaveLength(0);
      expect(await AgentQuestionModel.getById(question.id, { profileId: 'bob' })).toBeNull();
      expect(await AgentQuestionModel.listByConversation(conversationId, { profileId: 'bob' })).toHaveLength(0);
      expect((await AgentQuestionModel.listPending({ profileId: 'alice' })).map(q => q.id)).toEqual([question.id]);
      expect((await AgentQuestionModel.getById(question.id, { profileId: 'alice' }))?.id).toBe(question.id);

      // Answers: an out-of-scope claim fails closed and leaks nothing.
      const denied = await AgentQuestionModel.answer(question.id, {
        answers: [{ question: QUESTIONS[0].question, selected: ['Approve'] }],
      }, { profileId: 'bob' });
      expect(denied).toEqual({ ok: false, question: null });
      const stored = await pool.query('SELECT status FROM agent_questions WHERE id = $1', [question.id]);
      expect(stored.rows[0].status).toBe('pending');

      // The owning scope can still claim it.
      const claimed = await AgentQuestionModel.answer(question.id, {
        answers: [{ question: QUESTIONS[0].question, selected: ['Approve'] }],
      }, { profileId: 'alice' });
      expect(claimed.ok).toBe(true);
    });
  });
});
