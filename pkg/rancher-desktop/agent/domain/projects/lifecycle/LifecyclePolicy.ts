import { DomainError } from '../errors';
import { SemanticRole } from '../values';
import { CustodyReceipt } from './CustodyReceipt';
import { Dependency } from './Dependency';
import { DispatchLease } from './DispatchLease';
import { DurableWait } from './DurableWait';
import { LifecycleTransition } from './LifecycleTransition';

export interface LifecyclePolicyContext {
  dependencies?: readonly Dependency[];
  lease?: DispatchLease | null;
  waits?: readonly DurableWait[];
  custody?: readonly CustodyReceipt[];
  wipAvailable?: boolean;
  now: Date;
}

/** Pure invariant chain; persistence supplies the facts and commits only after this succeeds. */
export class LifecyclePolicy {
  static authorize(transition: LifecycleTransition, context: LifecyclePolicyContext): void {
    const enteringExecution = transition.to.semanticRole.equals(SemanticRole.EXECUTION);
    const enteringReview = transition.to.semanticRole.equals(SemanticRole.REVIEW);
    const enteringTerminal = transition.to.semanticRole.equals(SemanticRole.TERMINAL);

    if (context.dependencies?.some(dependency => !dependency.belongsTo(transition.to.id))) {
      throw new DomainError('Lifecycle dependency facts include another task');
    }
    if (context.waits?.some(wait => !wait.taskId.equals(transition.to.id))) {
      throw new DomainError('Lifecycle wait facts include another task');
    }
    if (context.lease && !context.lease.belongsTo(transition.to.id)) {
      throw new DomainError('Lifecycle lease belongs to another task');
    }

    if (enteringExecution && context.dependencies?.some(dependency => !dependency.satisfied)) {
      throw new DomainError('Task has unsatisfied dependencies');
    }
    if (enteringExecution && context.wipAvailable === false) {
      throw new DomainError('Destination lane WIP limit is reached');
    }
    if (context.waits?.some(wait => wait.active
      && wait.belongsTo(transition.from.id, transition.from.artifactGeneration))) {
      throw new DomainError('Task has an active durable wait for this generation');
    }
    if (transition.from.semanticRole.equals(SemanticRole.EXECUTION) && context.lease?.isActive(context.now)) {
      if (!context.lease.isOwnedBy(transition.actor, transition.from.artifactGeneration)) {
        throw new DomainError('Active dispatch lease is owned by another actor or generation');
      }
    }
    if (enteringReview || enteringTerminal) {
      const hasCustody = context.custody?.some(receipt =>
        receipt.matches(transition.to.id, transition.to.artifactGeneration)) ?? false;
      if (!hasCustody) throw new DomainError('Artifact custody is required for review or terminal entry');
    }
  }
}
