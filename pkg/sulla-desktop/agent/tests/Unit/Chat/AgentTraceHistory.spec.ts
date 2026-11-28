// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AgentTraceHistory } from '@pkg/agent/app/Services/AgentTraceHistory';
import { SubAgentTraceProjection } from '@pkg/pages/chat/components/transcript/SubAgentTraceProjection';
import type { AgentJobCheckin } from '@pkg/agent/database/models/AgentJobMessagingModel';

describe('AgentTraceHistory', () => {
  it('reads full history for an owned job task but not another conversation or a missing task', async() => {
    // risk: leaking a different conversation's worker logs or loading the wrong task.
    const checkins: AgentJobCheckin[] = Array.from({ length: 5 }, (_, index) => ({
      step: 'testing', summary: `Check-in ${index}\nFull detail`, createdAt: index * 1000,
      blockers: [], filesTouched: [], percent: index * 20,
    }));
    const messages = [{ id: 'm1', jobId: 'job', taskIndex: 1, message: 'Use the published version id,\nnot updatedAt.', createdAt: 2_500 }];
    const requests: [string, number][] = [];
    const history = new AgentTraceHistory({
      async job(id) { return id === 'job' ? { parentThreadId: 'owner', tasks: [{ runLocation: 'vm' }, { runLocation: 'container' }] } : undefined },
    }, {
      async checkinsForTask(...request) { requests.push(request); return checkins },
      async messagesForTask(jobId, taskIndex) { return jobId === 'job' && taskIndex === 1 ? messages : [] },
    });
    expect(await history.get('other', 'job', 1)).toBeNull();
    expect(await history.get('owner', 'job', 2)).toBeNull();
    expect(await history.get('owner', 'missing', 0)).toBeNull();
    expect(requests).toEqual([]);
    const owned = await history.get('owner', 'job', 1);
    expect(requests).toEqual([['job', 1]]);
    expect(owned).toEqual({ checkins, messages: [{ message: messages[0].message, createdAt: 2_500 }], runLocation: 'container' });

    const rendered = new SubAgentTraceProjection().disclosure({
      marker: 'W', brief: 'Full\nbrief', report: 'Full\nreport', checkinAt: 4000, checkinSummary: checkins[4].summary,
    }, 'returned', owned?.checkins, owned?.messages);
    for (const checkin of checkins) expect(rendered).toContain(checkin.summary);
    expect(rendered.split(checkins[4].summary)).toHaveLength(2);
    expect(rendered).toContain('Full\nbrief');
    expect(rendered).toContain('Full\nreport');
    // risk: hiding or reordering what the worker was told mid-run, or naming a sender
    // agent_job_messages never recorded.
    const sent = rendered.indexOf('← message: Use the published version id,\nnot updatedAt.');
    expect(rendered).not.toContain('← Sulla:');
    expect(sent).toBeGreaterThan(rendered.indexOf(checkins[2].summary));
    expect(sent).toBeLessThan(rendered.indexOf(checkins[3].summary));
  });
});
