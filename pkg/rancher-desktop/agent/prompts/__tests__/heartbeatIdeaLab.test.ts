import { describe, expect, it } from '@jest/globals';

import { formatIdeaLabDigest, IDEA_LAB_PROJECT_SLUG } from '../heartbeatIdeaLab';

import type { WorkTaskRecord } from '../../database/models/WorkItemsModel';

const NOW = Date.parse('2026-09-27T14:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function task(overrides: Partial<WorkTaskRecord>): WorkTaskRecord {
  return {
    id:               'id',
    project_id:       'lab',
    epic_id:          null,
    parent_id:        null,
    slug:             null,
    title:            'Idea',
    description:      '',
    status:           'backlog',
    priority:         'p2',
    due_at:           null,
    start_at:         null,
    milestone_at:     null,
    github_issue:     null,
    assignee:         'heartbeat',
    labels:           ['idea'],
    position:         0,
    source:           null,
    source_ref:       null,
    created_at:       minutesAgo(30),
    updated_at:       minutesAgo(30),
    last_moved_at:    minutesAgo(30),
    last_activity_at: minutesAgo(30),
    created_by:       'heartbeat',
    last_moved_by:    'heartbeat',
    completed_at:     null,
    archived:         false,
    ...overrides,
  };
}

describe('formatIdeaLabDigest', () => {
  it('tells Heartbeat to create the lab and raises a stagnation alert when it is missing', () => {
    const digest = formatIdeaLabDigest({ nowMs: NOW, project: null, tasks: [], lastHeartbeatWriteAt: null });
    expect(digest).toMatch(/^STAGNATION ALERT: /);
    expect(digest).toContain('the idea lab does not exist yet');
    expect(digest).toContain(`slug '${ IDEA_LAB_PROJECT_SLUG }'`);
    expect(digest).toContain('Brainstorming and running a new experiment is mandatory this wake');
  });

  it('lists recent ideas newest first with counts and no alert when Heartbeat is active', () => {
    const digest = formatIdeaLabDigest({
      nowMs:   NOW,
      project: { id: 'lab', title: 'Heartbeat Idea Lab' },
      tasks:   [
        task({ id: 'old', title: 'Older idea', created_at: minutesAgo(300), last_activity_at: minutesAgo(300), updated_at: minutesAgo(300), last_moved_at: minutesAgo(300), status: 'done', labels: ['experiment', 'win'], completed_at: minutesAgo(200) }),
        task({ id: 'new', title: 'Fresh idea', created_at: minutesAgo(20), last_activity_at: minutesAgo(10), updated_at: minutesAgo(10), last_moved_at: minutesAgo(20) }),
        task({ id: 'live', title: 'Live test', labels: ['idea', 'experiment'], last_activity_at: minutesAgo(15), updated_at: minutesAgo(15) }),
      ],
      lastHeartbeatWriteAt: minutesAgo(10),
    });

    expect(digest).not.toContain('STAGNATION ALERT');
    expect(digest).toContain('Ideas: 3 total · 1 untried · 1 live experiments · 1 wins · 0 losses');
    expect(digest).toContain('Last new idea: 20m ago · Last Heartbeat Projects write: 10m ago');
    expect(digest.indexOf('Fresh idea')).toBeLessThan(digest.indexOf('Live test'));
    expect(digest.indexOf('Live test')).toBeLessThan(digest.indexOf('Older idea'));
    expect(digest).toContain('do not repeat these');
  });

  it('flags stagnation when no new idea or Heartbeat write happened recently', () => {
    const digest = formatIdeaLabDigest({
      nowMs:                NOW,
      project:              { id: 'lab', title: 'Heartbeat Idea Lab' },
      tasks:                [task({ created_at: minutesAgo(600) })],
      lastHeartbeatWriteAt: minutesAgo(180),
    });

    expect(digest).toMatch(/^STAGNATION ALERT: /);
    expect(digest).toContain('no Heartbeat-authored Projects write for 3h');
    expect(digest).toContain('no new idea logged for 10h');
  });
});
