import Logging from '@pkg/utils/logging';

const console = Logging.background;

type StepCallback = () => void | Promise<void>;

interface RegisteredStep {
  name:       string;
  conditions: string[];
  callback:   StepCallback;
  fired:      boolean;
}

/**
 * Coordinates the first-run flow between the user wizard and backend boot.
 *
 * Tracks boolean conditions and registered steps. When a condition is set,
 * all pending steps are evaluated — any step whose conditions are all met
 * fires exactly once, in registration order.
 */
export class FirstRunCoordinator {
  private conditions = new Map<string, boolean>();
  private steps: RegisteredStep[] = [];

  /**
   * Declare a condition name. All start as false.
   */
  addCondition(name: string): void {
    this.conditions.set(name, false);
  }

  /**
   * Register a step that fires when ALL its required conditions are true.
   * Each step fires at most once. Steps fire in registration order.
   */
  registerStep(name: string, conditions: string[], callback: StepCallback): void {
    for (const c of conditions) {
      if (!this.conditions.has(c)) {
        throw new Error(`FirstRunCoordinator: step "${ name }" references undeclared condition "${ c }"`);
      }
    }
    this.steps.push({
      name, conditions, callback, fired: false,
    });
  }

  /**
   * Mark a condition as met and evaluate all pending steps.
   * Idempotent — calling twice for the same condition is a no-op.
   */
  async setCondition(name: string): Promise<void> {
    if (!this.conditions.has(name)) {
      console.warn(`[FirstRunCoordinator] Unknown condition: ${ name }`);

      return;
    }
    if (this.conditions.get(name)) {
      return;
    }
    console.log(`[FirstRunCoordinator] Condition met: ${ name }`);
    this.conditions.set(name, true);
    await this.evaluate();
  }

  /**
   * Check all registered steps. Fire any whose conditions are all met.
   * Steps fire sequentially in registration order.
   */
  private async evaluate(): Promise<void> {
    for (const step of this.steps) {
      if (step.fired) {
        continue;
      }
      const allMet = step.conditions.every(c => this.conditions.get(c) === true);

      if (allMet) {
        step.fired = true;
        console.log(`[FirstRunCoordinator] Firing step: ${ step.name }`);
        try {
          await step.callback();
          console.log(`[FirstRunCoordinator] Step completed: ${ step.name }`);
        } catch (err) {
          console.error(`[FirstRunCoordinator] Step "${ step.name }" failed:`, err);
        }
      }
    }
  }
}
