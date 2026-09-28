/**
 * Human-comment triage for Heartbeat.
 *
 * When the human comments on a ticket (desktop Projects UI or Sulla Mobile,
 * both stamp author "human"), Heartbeat owes that ticket a look even if the
 * dispatcher would never pick it: parked, blocked, dependency-held, owned by
 * a protected lifecycle stage, or done. Heartbeat reads the comment, decides
 * whether the ticket must change or be dispatched, acts, and replies with an
 * author="heartbeat" comment. That reply clears the ticket from this queue.
 *
 * A ticket with a live stage claim (a worker is on it right now) is skipped
 * until the claim ends, so triage never races an active dispatch.
 */
import { LifecycleCapabilityModel } from '../database/models/LifecycleCapabilityModel';
import { WorkItemsModel, type HumanCommentAwaitingReply } from '../database/models/WorkItemsModel';

export const HUMAN_COMMENT_RESPONDER = 'heartbeat';
export const HUMAN_COMMENT_WINDOW_DAYS = 14;

export async function listHumanCommentTriage(limit = 20): Promise<HumanCommentAwaitingReply[]> {
  const rows = await WorkItemsModel.listTasksAwaitingHumanReply({ responder: HUMAN_COMMENT_RESPONDER, sinceDays: HUMAN_COMMENT_WINDOW_DAYS, limit });
  if (!rows.length) return rows;
  const access = await LifecycleCapabilityModel.heartbeatAccessByTask(rows.map(row => row.task));
  return rows.filter(row => !access.get(row.task.id)?.liveClaim);
}
