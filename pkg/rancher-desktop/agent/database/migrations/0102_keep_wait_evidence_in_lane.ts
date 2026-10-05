/** Comments and generic edits are evidence, not approval or lane transitions. */
export const up = `
  DROP TRIGGER IF EXISTS trg_settle_work_task_waits_on_replan ON work_tasks;
  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_comment ON work_task_comments;
  DROP TRIGGER IF EXISTS trg_invalidate_work_task_waits_from_human_task_mutation ON work_tasks;
`;

export const down = `
  CREATE TRIGGER trg_settle_work_task_waits_on_replan
    AFTER UPDATE OF status ON work_tasks
    FOR EACH ROW EXECUTE FUNCTION settle_work_task_waits_on_replan();
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_comment
    AFTER INSERT ON work_task_comments
    FOR EACH ROW EXECUTE FUNCTION invalidate_work_task_waits_from_human_comment();
  CREATE TRIGGER trg_invalidate_work_task_waits_from_human_task_mutation
    AFTER UPDATE ON work_tasks
    FOR EACH ROW EXECUTE FUNCTION invalidate_work_task_waits_from_human_task_mutation();
`;
