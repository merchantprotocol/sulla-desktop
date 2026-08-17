import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { KnowledgeGraphModel } from '../../../database/models/KnowledgeGraphModel';
import { EpisodicRecallWorker, formatEpisodicContext } from '../episodic_recall';

describe('episodic_recall tool', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('formats recalled nodes as activated episodic context lines', () => {
    const context = formatEpisodicContext([
      {
        id:               'issue-517',
        node_type:        'issue',
        title:            'GitHub issue #517',
        summary:          'Recall agent graph retrieval',
        detail:           null,
        link_count:       8,
        recall_count:     3,
        last_recalled_at: null,
        archived:         false,
        merged_into:      null,
        source:           'test',
        created_at:       '2026-07-30T00:00:00.000Z',
        updated_at:       '2026-07-30T00:00:00.000Z',
        activation:       1,
        hop:              0,
      },
      {
        id:               'voice-latency',
        node_type:        'lesson',
        title:            'Voice latency blocker',
        summary:          'Legacy recall takes 40-50s before voice can answer',
        detail:           null,
        link_count:       5,
        recall_count:     1,
        last_recalled_at: null,
        archived:         false,
        merged_into:      null,
        source:           'test',
        created_at:       '2026-07-30T00:00:00.000Z',
        updated_at:       '2026-07-30T00:00:00.000Z',
        activation:       0.45,
        hop:              1,
      },
    ]);

    expect(context).toContain('[issue] GitHub issue #517 — Recall agent graph retrieval');
    expect(context).toContain('(id: issue-517, activation: 1.000, hop: 0)');
    expect(context).toContain('[lesson] Voice latency blocker — Legacy recall takes 40-50s before voice can answer');
  });

  it('calls recallByTerms once with bounded defaults and returns an episodic_context block', async() => {
    jest.spyOn(KnowledgeGraphModel, 'recallByTerms').mockResolvedValue([{
      id:               'issue-517',
      node_type:        'issue',
      title:            'GitHub issue #517',
      summary:          'Recall agent graph retrieval',
      detail:           null,
      link_count:       8,
      recall_count:     3,
      last_recalled_at: null,
      archived:         false,
      merged_into:      null,
      source:           'test',
      created_at:       '2026-07-30T00:00:00.000Z',
      updated_at:       '2026-07-30T00:00:00.000Z',
      activation:       1,
      hop:              0,
    }]);

    const worker = new EpisodicRecallWorker();
    worker.schemaDef = {
      terms:      { type: 'array', items: { type: 'string' } },
      query_text: { type: 'string', optional: true },
      limit:      { type: 'number', optional: true },
    };
    const result = await worker.invoke({
      terms:      [' issue 517 ', 'voice recall', 'issue 517'],
      query_text: 'Please finish issue #517 for voice recall',
      limit:      99,
    });

    expect(KnowledgeGraphModel.recallByTerms).toHaveBeenCalledTimes(1);
    expect(KnowledgeGraphModel.recallByTerms).toHaveBeenCalledWith(
      ['issue 517', 'voice recall'],
      { maxHops: 2, decay: 0.5, limit: 24, statementTimeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain('<episodic_context>');
    expect(result.result).toContain('[issue] GitHub issue #517');
  });

  it('ignores non-string terms instead of coercing them into bogus anchors', async() => {
    jest.spyOn(KnowledgeGraphModel, 'recallByTerms').mockResolvedValue([]);

    const worker = new EpisodicRecallWorker();
    worker.schemaDef = {
      terms: { type: 'array', items: { type: 'string' } },
    };
    const result = await worker.invoke({
      terms: [' issue 517 ', null, false, { title: 'voice recall' }, 'issue 517', '  '],
    });

    expect(KnowledgeGraphModel.recallByTerms).toHaveBeenCalledTimes(1);
    expect(KnowledgeGraphModel.recallByTerms).toHaveBeenCalledWith(
      ['issue 517'],
      { maxHops: 2, decay: 0.5, limit: 12, statementTimeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe('<episodic_context />');
  });
});
