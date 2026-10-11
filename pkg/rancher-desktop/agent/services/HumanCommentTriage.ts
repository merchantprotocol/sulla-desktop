/**
 * Human-comment triage for Heartbeat.
 *
 * When the human comments on a ticket (desktop Projects UI or Sulla Mobile,
 * both stamp author "human"), Heartbeat owes that ticket a look whatever its
 * lane: parked, blocked, dependency-held or done. Heartbeat reads the comment,
 * decides whether the ticket must change, acts, and replies with an
 * author="heartbeat" comment. That reply clears the ticket from this queue.
 */
import { WorkItemsModel, type HumanCommentAwaitingReply } from '../database/models/WorkItemsModel';

export const HUMAN_COMMENT_RESPONDER = 'heartbeat';
export const HUMAN_COMMENT_WINDOW_DAYS = 14;

export function listHumanCommentTriage(limit = 20): Promise<HumanCommentAwaitingReply[]> {
  return WorkItemsModel.listTasksAwaitingHumanReply({ responder: HUMAN_COMMENT_RESPONDER, sinceDays: HUMAN_COMMENT_WINDOW_DAYS, limit });
}
